'use strict';
/* Settings menu (opened by the gear or the Red button) */
var settings = { open: false, focus: 0, items: [],
                 chat: false, lowlatency: false, autoadvance: false,
                 hideOffline: false, diagnostics: false, hideBots: true,
                 dim: false, rememberDim: false, dimStrength: 0.8, dimScope: 'video',
                 chatSize: 'medium', chatOpacity: 'high', chatSeparate: false,
                 chatBackground: 'black', chatTransparency: 84, chatBots: 'show',
                 chatEmotes: 'images', chatTimestamps: false, chatDelay: -1,
                 alerts: 'all', notifySec: 10, saverMin: 1,
                 uiText: 'normal', chatResizePreview: true };
// Chat choices belong to the watched streamer. The previous shared choices
// become a fixed starting point for streamers without a saved profile.
var CHAT_PREF_KEY = 'kicktv.chatprefs';
var CHAT_PREF_FIELDS = ['chat', 'chatSeparate', 'chatSize', 'chatOpacity', 'chatBackground',
  'chatTransparency', 'chatBots', 'chatEmotes', 'chatTimestamps', 'chatDelay', 'chatResizePreview'];
var chatPreferences = { defaults: null, profiles: Object.create(null), order: [], active: '' };
function chatStreamerSlug() { return state.current || (state.vod && state.vod.slug) || ''; }
function chatOptionsFrom(source, fallback) {
  var s = {}, input = source && typeof source === 'object' ? source : {};
  CHAT_PREF_FIELDS.forEach(function (key) {
    s[key] = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : (fallback && fallback[key]);
  });
  var transparency = parseInt(s.chatTransparency, 10);
  var oldTransparency = { off: 100, light: 84, dark: 68, black: 0, white: 0 };
  var delay = parseInt(s.chatDelay, 10);
  return {
    chat: s.chat === true, chatSeparate: s.chatSeparate === true, chatResizePreview: s.chatResizePreview !== false,
    chatSize: pickEnum(s.chatSize, ['small', 'medium', 'large'], 'medium'),
    chatOpacity: pickEnum(s.chatOpacity, ['low', 'medium', 'high'], 'high'),
    chatBackground: s.chatBackground === 'white' ? 'white' : 'black',
    chatTransparency: transparency >= 0 && transparency <= 100 ? transparency :
      (Object.prototype.hasOwnProperty.call(oldTransparency, s.chatBackground) ? oldTransparency[s.chatBackground] : 84),
    chatBots: pickEnum(s.chatBots, ['show', 'hide'], 'show'),
    chatEmotes: pickEnum(s.chatEmotes, ['images', 'text'], 'images'),
    chatTimestamps: s.chatTimestamps === true,
    chatDelay: delay >= -1 && delay <= 60 ? delay : -1   // -1: Auto, matched to the video
  };
}
var chatPreferencesSerialized = null, settingsSerialized = null;
function writeChatPreferences() {
  try {
    var serialized = JSON.stringify({ version: 1, delayAuto: true, defaults: chatPreferences.defaults,
      profiles: chatPreferences.profiles, order: chatPreferences.order });
    if (serialized === chatPreferencesSerialized) return;
    localStorage.setItem(CHAT_PREF_KEY, serialized);
    chatPreferencesSerialized = serialized;
  } catch (e) {}
}
function useChatOptions(options) {
  CHAT_PREF_FIELDS.forEach(function (key) { settings[key] = options[key]; });
}
function loadChatPreferences(legacy) {
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(CHAT_PREF_KEY)); } catch (e) {}
  var valid = stored && stored.version === 1 && stored.defaults && stored.profiles;
  // Message delay used to default to Off, so a saved Off is almost always that old
  // default rather than a choice. Move it to Auto once; delayAuto marks it done.
  var migrateDelay = !(valid && stored.delayAuto);
  function upgradeDelay(options) {
    if (migrateDelay && options.chatDelay === 0) options.chatDelay = -1;
    return options;
  }
  chatPreferences.defaults = upgradeDelay(chatOptionsFrom(valid ? stored.defaults : legacy));
  chatPreferences.defaults.chat = false; // New streamers always start with chat closed.
  chatPreferences.profiles = Object.create(null); chatPreferences.order = [];
  if (valid) {
    (Array.isArray(stored.order) ? stored.order : Object.keys(stored.profiles)).slice(-100).forEach(function (slug) {
      if (typeof slug !== 'string' || !slug || !Object.prototype.hasOwnProperty.call(stored.profiles, slug) ||
          !stored.profiles[slug] || typeof stored.profiles[slug] !== 'object' || chatPreferences.order.indexOf(slug) !== -1) return;
      chatPreferences.profiles[slug] = upgradeDelay(chatOptionsFrom(stored.profiles[slug], chatPreferences.defaults));
      chatPreferences.order.push(slug);
    });
  }
  chatPreferences.active = chatStreamerSlug();
  useChatOptions(chatPreferences.profiles[chatPreferences.active] || chatPreferences.defaults);
  if (!valid || migrateDelay || stored.defaults.chat !== false) writeChatPreferences();
}
function rememberChatPreferences() {
  var slug = chatPreferences.active;
  if (!slug || !chatPreferences.defaults) return;
  var next = chatOptionsFrom(settings), previous = chatPreferences.profiles[slug] || chatPreferences.defaults;
  if (CHAT_PREF_FIELDS.every(function (key) { return next[key] === previous[key]; })) return;
  chatPreferences.profiles[slug] = next;
  var idx = chatPreferences.order.indexOf(slug);
  if (idx !== -1) chatPreferences.order.splice(idx, 1);
  chatPreferences.order.push(slug);
  while (chatPreferences.order.length > 100) delete chatPreferences.profiles[chatPreferences.order.shift()];
  writeChatPreferences();
}
function selectChatPreferences() {
  var slug = chatStreamerSlug();
  if (slug === chatPreferences.active) return false;
  rememberChatPreferences();             // also keep a slider preview if the channel changes mid-drag
  chatPreferences.active = slug;
  useChatOptions(chatPreferences.profiles[slug] || chatPreferences.defaults);
  return true;
}
function applyStreamerChatPreferences() {
  if (!selectChatPreferences()) return;
  disconnectChat();                      // discard the previous room's delayed messages and reconnect timer
  applyChatStyle();
  if (chatopt.open) renderChatOpt();
  if (settings.open) renderSettings();
}
var SETTINGS_IDLE_MS = 30000;
var settingsIdleTimer = null;
function touchSettings() {
  if (!settings.open && !(qualityopt && qualityopt.open) && !(chatopt && chatopt.open)) return;
  clearTimeout(settingsIdleTimer);
  settingsIdleTimer = setTimeout(closeSettingsStack, SETTINGS_IDLE_MS);
}
function closeSettingsStack() {
  updateopen = false;
  dimopt.open = false;
  chatopt.open = false;
  blockedcats.open = false;
  qualityopt.open = false;
  document.getElementById('blockedcatsmodal').className = 'hidden';
  document.getElementById('updatemodal').className = 'hidden';
  document.getElementById('dimoptmodal').className = 'hidden';
  document.getElementById('chatoptmodal').className = 'hidden';
  document.getElementById('qualityoptmodal').className = 'hidden';
  closeSettings();
}
function pickEnum(v, allowed, def) { for (var i = 0; i < allowed.length; i++) if (v === allowed[i]) return v; return def; }
function loadSettings() {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('kicktv.settings')) || {}; } catch (e) {}
  settings.lowlatency = !!s.lowlatency;
  settings.autoadvance = !!s.autoadvance;
  settings.hideOffline = !!s.hideOffline;
  settings.diagnostics = !!s.diagnostics;
  settings.hideBots = s.hideBots !== false;      // on unless deliberately turned off
  settings.rememberDim = s.rememberDim === true;
  settings.dim = settings.rememberDim && s.dim === true;
  var st = parseFloat(s.dimStrength);
  settings.dimStrength = (st >= 0.1 && st <= 0.98) ? st : 0.8;
  settings.dimScope = (s.dimScope === 'all') ? 'all' : 'video';
  settings.uiText = s.uiText === 'large' ? 'large' : 'normal';
  settings.qualityAlert = s.qualityAlert !== false;   // on unless turned off in the Quality picker
  loadChatPreferences(s);
  // Alerts + burn-in guard
  settings.alerts = pickEnum(s.alerts, ['all', 'pinned', 'off'], 'all');
  var nsec = parseInt(s.notifySec, 10);
  settings.notifySec = nsec >= 5 && nsec <= 30 ? nsec : 10;
  var sm = parseInt(s.saverMin, 10);
  settings.saverMin = sm >= 0 && sm <= 10 ? sm : 1;
}
function saveSettings() {
  if (chatPreferences.active === chatStreamerSlug()) rememberChatPreferences();
  try {
    var serialized = JSON.stringify({
      lowlatency: settings.lowlatency, autoadvance: settings.autoadvance,
      hideOffline: settings.hideOffline, diagnostics: settings.diagnostics,
      hideBots: settings.hideBots,
      dim: settings.rememberDim ? settings.dim : false, rememberDim: settings.rememberDim,
      dimStrength: settings.dimStrength, dimScope: settings.dimScope,
      alerts: settings.alerts, notifySec: settings.notifySec, saverMin: settings.saverMin,
      uiText: settings.uiText, qualityAlert: settings.qualityAlert
    });
    if (serialized !== settingsSerialized) {
      localStorage.setItem('kicktv.settings', serialized);
      settingsSerialized = serialized;
    }
  } catch (e) {}
}
function popupDimFilter() {
  if (!settings.dim) return '';
  return 'brightness(' + Math.max(0.02, 1 - settings.dimStrength) + ')';
}
function settingsDimFilter() {
  if (!settings.dim) return '';
  // Only Settings stops at Medium even when video strength is Strong or Max.
  var uiStrength = Math.min(settings.dimStrength, 0.6);
  return 'brightness(' + (1 - uiStrength) + ')';
}
function applyDim() {
  var el = document.getElementById('dimscreen');
  el.className = '';               // always in the layer tree; visibility rides on opacity
  el.style.background = 'rgba(0,0,0,' + settings.dimStrength + ')';
  el.style.zIndex = (settings.dimScope === 'all') ? '68' : '';   // 'all' rides above normal player UI
  // Max -> off is the harshest jump (darkest state to full brightness), so it
  // brightens extra slowly; every other fade uses the stylesheet's 3s.
  el.style.transitionDuration = (!settings.dim && settings.dimStrength > 0.9) ? '10s, 1s' : '';
  el.style.opacity = settings.dim ? '1' : '0';   // the CSS transition makes this a gentle fade
  applyDimAwareUi();
}
// Stream quality is intentionally not a setting; it has its own player control.
function settingsBuild() {
  var items = [
    { kind: 'chatopt', label: 'Live chat' },
    { kind: 'toggle', key: 'lowlatency', label: 'Low latency' },
    { kind: 'toggle', key: 'autoadvance', label: 'Auto-advance' },
    { kind: 'toggle', key: 'hideOffline', label: 'Hide offline' },
    { kind: 'toggle', key: 'hideBots', label: 'Hide bot streams' },
    { kind: 'blockedcats', label: 'Blocked categories' },
    { kind: 'backup', label: 'Backup & restore' },
    { kind: 'toggle', key: 'diagnostics', label: 'Diagnostics' },
    { kind: 'choice', key: 'uiText', label: 'Big UI', values: [{ v: 'normal', label: 'Normal' }, { v: 'large', label: 'Large' }] },
    { kind: 'dimopt', label: 'Dim (night)' },
    { kind: 'choice', key: 'alerts', label: 'Live alerts',
      values: [{ v: 'all', label: 'All' }, { v: 'pinned', label: 'Pinned only' }, { v: 'off', label: 'Off' }] },
    { kind: 'range', key: 'notifySec', label: 'Alert duration',
      range: { id: 'alert-duration', min: 5, max: 30, step: 1, unit: 'sec' } },
    { kind: 'range', key: 'saverMin', label: 'Burn-in guard',
      range: { id: 'burn-in-guard', min: 0, max: 10, step: 1, unit: 'min' } }
  ];
  // (The update entry lives as a chip in the Settings header, not a list row.)
  return items;
}
function firstFocusableSetting() {
  for (var i = 0; i < settings.items.length; i++) if (settings.items[i].kind !== 'header') return i;
  return 0;
}
function openSettings() {
  applyStreamerChatPreferences();
  if (!state.ready || settings.open) return;
  hideQualityHint();
  sidePreviewCard.cancel();
  settings.open = true;
  setMode('settings');
  settings.items = settingsBuild();
  settings.focus = firstFocusableSetting();
  document.getElementById('settingsmodal').className = '';
  renderSettingsVer();
  renderSettings();
  if (window.UIPolish) UIPolish.place('settingsbox');
  touchSettings();
}
function closeSettings() {
  if (settings.open) saveSettings();
  clearTimeout(settingDescTimer);
  clearTimeout(settingsIdleTimer);
  settingsIdleTimer = null;
  settings.open = false;
  document.getElementById('settingsmodal').className = 'hidden';
  document.getElementById('settings-desc').className = 'hidden';
  setMode('player');
  if (state.sidebarOpen) { resetIdle(); scheduleSidePreview(); }
  pumpNotify();
}
// Use the same switch for booleans and named two-choice settings.
function settingSwitch(label, on) {
  var control = document.createElement('span');
  control.className = 'spill chat-toggle' + (on ? ' on' : '');
  control.setAttribute('role', 'switch');
  control.setAttribute('aria-label', label);
  control.setAttribute('aria-checked', String(!!on));
  control.setAttribute('data-setting-switch', '1');
  return control;
}
function settingChoices(label, choices, current, select) {
  var group = document.createElement('div'); group.className = 'setting-choices';
  group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', label);
  choices.forEach(function (choice, index) {
    var value = Array.isArray(choice) ? choice[0] : choice.v;
    var title = Array.isArray(choice) ? choice[1] : choice.label;
    var button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
    button.className = 'setting-choice' + (value === current ? ' selected' : '');
    button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(value === current));
    button.setAttribute('data-value', String(value)); button.textContent = title;
    button.addEventListener('click', function (event) { event.stopPropagation(); select(index); });
    group.appendChild(button);
  });
  return group;
}
function settingsRangeLabel(it) {
  return it.key === 'saverMin' && !settings[it.key] ? 'Off' : settings[it.key] + ' ' + it.range.unit;
}
function paintSettingsRange(it) {
  var slider = document.getElementById(it.range.id);
  if (!slider) return;
  var value = settings[it.key], percent = (value - it.range.min) / (it.range.max - it.range.min) * 100;
  slider.value = value;
  slider.style.backgroundImage = 'linear-gradient(to right, #53fc18 ' + percent + '%, #4a5156 ' + percent + '%)';
  slider.setAttribute('aria-valuetext', !value ? 'Off' : value + (it.key === 'notifySec' ? ' seconds' : value === 1 ? ' minute' : ' minutes'));
  slider.parentNode.querySelector('.spill').textContent = settingsRangeLabel(it);
}
function setSettingsRange(it, value, persist) {
  settings[it.key] = Math.max(it.range.min, Math.min(it.range.max, Math.round(Number(value) || 0)));
  paintSettingsRange(it); touchSettings();
  if (it.key === 'saverMin' && !settings.saverMin) wakeSaver();
  if (persist) saveSettings();
}
function bindSettingsListPointer(list, onHover) {
  var pointer = null, wheelPointer = null;
  function hover(event) {
    // Scrolling can move another row under a stationary Magic Remote pointer.
    // Only real pointer movement should resume hover navigation after the wheel.
    if (wheelPointer) {
      if (event.type !== 'mousemove' || Math.abs(event.clientX - wheelPointer.x) + Math.abs(event.clientY - wheelPointer.y) <= 3) return;
      wheelPointer = null;
    }
    pointer = { x: event.clientX, y: event.clientY };
    onHover(event);
  }
  list.addEventListener('mouseover', hover);
  list.addEventListener('mousemove', hover);
  list.addEventListener('wheel', function (event) {
    if (!event.deltaY) return;
    event.preventDefault(); event.stopPropagation();
    wheelPointer = pointer || { x: event.clientX, y: event.clientY };
    list.scrollTop += event.deltaY > 0 ? 88 : -88;
    clearTimeout(settingDescTimer);
    document.getElementById('settings-desc').className = 'hidden';
    markInput();
  }, { passive: false });
}
function renderSettings() {
  var list = document.getElementById('settings-list');
  list.innerHTML = '';
  settings.items.forEach(function (it, i) {
    var el = document.createElement('div');
    el.setAttribute('data-idx', i);
    el.className = 'srow' + (it.kind === 'range' ? ' setting-range-row' : '');
    if (it.kind === 'header') {
      el.className = 'shead'; el.textContent = it.label; list.appendChild(el); return;
    }
    el.setAttribute('data-focusable', '1');
    var lab = document.createElement('span'); lab.className = 'slabel'; lab.textContent = it.label;
    el.appendChild(lab);
    var binary = it.kind === 'choice' && it.values.length === 2;
    var value = document.createElement('span'); value.className = 'settings-value';
    if (it.kind === 'toggle' || it.kind === 'dimopt' || it.kind === 'chatopt' || binary) {
      var on = it.kind === 'dimopt' ? settings.dim : it.kind === 'chatopt' ? settings.chat :
        binary ? settings[it.key] === it.values[1].v : !!settings[it.key];
      value.setAttribute('data-setting-switch', '1');
      value.appendChild(settingSwitch(it.label, on));
    } else if (it.kind === 'choice') {
      value.classList.add('setting-choice-value');
      value.appendChild(settingChoices(it.label, it.values, settings[it.key], function (index) {
        settings.focus = i; selectChoice(it, index); renderSettings();
      }));
    } else {
      var pill = document.createElement('span'); pill.className = 'spill';
      pill.textContent = it.kind === 'blockedcats' ? String(getBlockedCats().length) : it.kind === 'backup' ? 'Phone' : settingsRangeLabel(it);
      value.appendChild(pill);
    }
    el.appendChild(value);
    if (it.kind === 'range') {
      var slider = document.createElement('input'); slider.type = 'range'; slider.tabIndex = -1;
      slider.id = it.range.id; slider.className = 'chat-setting-slider';
      slider.min = String(it.range.min); slider.max = String(it.range.max); slider.step = String(it.range.step);
      slider.setAttribute('aria-label', it.label);
      slider.addEventListener('input', function () {
        settings.focus = i; applySettingsFocus(true); setSettingsRange(it, this.value, false);
      });
      slider.addEventListener('change', function () { setSettingsRange(it, this.value, true); });
      el.appendChild(slider);
    }
    list.appendChild(el);
  });
  settings.items.forEach(function (it) { if (it.kind === 'range') paintSettingsRange(it); });
  applySettingsFocus();
}
function focusPanelRow(list, index, preserveScroll) {
  var next = list.children[index];
  if (list._focusRow !== next) {
    if (list._focusRow) list._focusRow.classList.remove('focused');
    if (next) next.classList.add('focused');
    list._focusRow = next;
  }
  if (next && !preserveScroll) scrollIntoViewport(list, next, 6);
  return next;
}
function applySettingsFocus(preserveScroll) {
  var list = document.getElementById('settings-list');
  var focused = focusPanelRow(list, settings.focus, preserveScroll);
  showSettingDesc('settings-desc', descForSettingItem(settings.items[settings.focus]), focused);
}
function settingsMove(delta) {
  var n = settings.focus;
  while (true) {
    n += delta;
    if (n < 0 || n >= settings.items.length) return;
    if (settings.items[n].kind !== 'header') break;
  }
  settings.focus = n;
  applySettingsFocus();
}
function settingsActivate(dir) {
  dir = dir || 1;
  var it = settings.items[settings.focus];
  if (!it) return;
  if (it.kind === 'toggle') {
    settings[it.key] = !settings[it.key];
    saveSettings();
    applyToggle(it.key);
    renderSettings();
  } else if (it.kind === 'dimopt') {
    settings.dim = !settings.dim;              // the row itself just toggles dim on/off
    saveSettings();
    applyDim();
    toast('Dim ' + (settings.dim ? 'on' : 'off'));
    renderSettings();
  } else if (it.kind === 'chatopt') {
    if (!chatStreamerSlug()) { toast('Choose a streamer first'); return; }
    applyStreamerChatPreferences();
    if (!settings.chat && !chatCanTurnOn()) return;
    settings.chat = !settings.chat;            // the row itself just toggles chat on/off
    saveSettings();
    applyToggle('chat');
    renderSettings();
  } else if (it.kind === 'blockedcats') {
    openBlockedCats();                         // no toggle semantics; Right opens it too
  } else if (it.kind === 'backup') {
    openBackup();
  } else if (it.kind === 'range') {
    setSettingsRange(it, settings[it.key] + dir * it.range.step, true);
  } else if (it.kind === 'choice') {
    cycleChoice(it, dir);
    renderSettings();
  }
}
function settingsOk() {
  var it = settings.items[settings.focus];
  if (it && it.kind === 'dimopt') openDimOpt();
  else if (it && it.kind === 'chatopt') openChatOpt();
  else if (it && it.kind === 'blockedcats') openBlockedCats();
  else if (it && it.kind === 'backup') openBackup();
  else settingsActivate();
}
// Find the display label for a 'choice' row's current value.
function choiceLabel(it) {
  for (var i = 0; i < it.values.length; i++) if (it.values[i].v === settings[it.key]) return it.values[i].label;
  return '';
}
// Step a 'choice' row to its next (dir +1) or previous (dir -1) value and apply it.
function cycleChoice(it, dir) {
  dir = dir || 1;
  var idx = 0, n = it.values.length;
  for (var i = 0; i < n; i++) if (it.values[i].v === settings[it.key]) { idx = i; break; }
  selectChoice(it, ((idx + dir) % n + n) % n);
}
function selectChoice(it, index) {
  var n = it.values.length, nv = it.values[index];
  if (!nv) return;
  settings[it.key] = nv.v;
  saveSettings();
  if (it.key === 'alerts') pruneNotifications();
  if (it.key === 'uiText' && window.UIPolish) {
    UIPolish.apply(); sideLayout = null; sideTextStyle = null; renderSidebar();
  }
  toast(it.label + ': ' + (n === 2 ? (nv.v === it.values[1].v ? 'On' : 'Off') : nv.label));
}
/* A short description of the focused setting, shown in the detached context
   card used by the original Settings layout. */
var SETTINGS_DESC = {
  uiText: 'Larger labels and controls for easier reading from the sofa. Video size stays the same.',
  chat: 'Green toggles live chat. Drag anywhere to move, use any corner to resize, or release at an edge to dock. Each streamer remembers all chat settings and its layout.',
  lowlatency: 'Stay closer to live. This may buffer more on a slower connection.',
  autoadvance: 'Continue with the next VOD from that streamer, or another live channel. Live pinned channels come first.',
  hideOffline: 'Put offline channels in a collapsed group at the bottom. Open the group whenever you need it.',
  hideBots: 'Hide fake streams from Browse — the ones with random channel names and random titles that pad their viewer counts.',
  blockedcats: 'Categories you would rather not see. Followed channels streaming in one drop to the bottom of the list, greyed out, and stay quiet. Block a category from Browse, then Categories.',
  backup: 'Save your channels and settings to your phone, bring them back after a reinstall, or add channels by typing names on the phone. Scan the code with the phone camera.',
  diagnostics: 'Show playback quality, network, buffer, live delay, frame and recovery information.',
  dim: 'Reduce screen brightness. Press OK or select the label for strength, scope and startup behavior, or press 0 while watching.',
  alerts: 'Choose which followed channels may show a live alert when they come online.',
  notifySec: 'Keep each live alert on screen for 5–30 seconds. Drag the slider, or use Left and Right to adjust by one second.',
  saverMin: 'Dim a still screen after 1–10 idle minutes, or choose Off. Left and Right adjust by one minute. Movement or remote input wakes the screen.'
};
var DIMOPT_DESC = [
  'Turn night dimming on or off.',
  'How dark the dimming is.',
  'Dim only the video, or everything including the menus and sidebar.',
  'Start the app with dimming in the same on/off state as last time. When off, the app always starts undimmed.'
];
function descForSettingItem(it) {
  if (!it) return '';
  if (it.kind === 'chatopt') return SETTINGS_DESC.chat;
  if (it.kind === 'dimopt') return SETTINGS_DESC.dim;
  if (it.kind === 'blockedcats') return SETTINGS_DESC.blockedcats;
  if (it.kind === 'backup') return SETTINGS_DESC.backup;
  if (it.kind === 'toggle' || it.kind === 'choice' || it.kind === 'range') return SETTINGS_DESC[it.key] || '';
  return '';
}
var settingDescTimer = null;
// `owner` is 'quality' when the Quality picker asks; otherwise the balloon belongs
// to Settings or Chat options and stays down while the picker covers them.
function showSettingDesc(id, text, target, owner) {
  clearTimeout(settingDescTimer);
  var previous = document.getElementById(id);
  if (previous) previous.className = 'hidden';
  settingDescTimer = setTimeout(function () { paintSettingDesc(id, text, target, owner); }, 240);
}
function paintSettingDesc(id, text, target, owner) {
  var el = document.getElementById(id);
  if (!el) return;
  var ownerOpen = owner === 'quality' ? qualityopt.open
    : ((settings.open || chatopt.open) && !(qualityopt && qualityopt.open));
  if (!text || !target || !document.documentElement.contains(target) || !target.offsetHeight ||
      !ownerOpen || updateopen || backup.open || wtw.open) {
    el.className = 'hidden';
    return;
  }
  el.textContent = text || '';
  el.style.filter = settingsDimFilter();
  el.className = 'point-right';
  var r = target.getBoundingClientRect();
  var top = r.top + (r.height - el.offsetHeight) / 2;
  top = Math.max(24, Math.min(1080 - el.offsetHeight - 24, top));
  var left = r.left - el.offsetWidth - 32;
  if (left < 24) {
    left = r.right + 32;
    el.className = 'point-left';
  }
  var arrowTop = r.top + r.height / 2 - top;
  arrowTop = Math.max(18, Math.min(el.offsetHeight - 18, arrowTop));
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
  el.style.setProperty('--arrow-top', Math.round(arrowTop) + 'px');
  if (window.UIPolish) UIPolish.place(el, target);
}
function applyDimAwareUi() {
  var popupFilter = popupDimFilter();
  var settingsFilter = settingsDimFilter();
  var desc = document.getElementById('settings-desc');
  desc.style.filter = settingsFilter;
  var qualityHint = document.getElementById('quality-hint');
  qualityHint.style.filter = popupFilter;
  // Settings remains readable at no darker than Medium. Every other popup uses
  // the selected strength, including Strong and Max.
  var settingsPopups = ['settingsbox', 'dimoptbox', 'chatoptbox', 'blockedcatsbox', 'backupbox'];
  var upperPopups = ['confirmbox', 'addbox', 'updatebox', 'qualityoptbox', 'wtwbox', 'toast'];
  var lowerPopups = ['browse-panel', 'cats-panel', 'vods-panel', 'chpop-panel',
                     'pbstatus', 'overlay', 'vodbar', 'vodplay', 'vodback', 'vodfwd', 'seekpop', 'spinner',
                     'livebar'];
  // The lower group already sits under the Everything dim layer. Applying a
  // second filter there would dim it twice.
  var lowerFilter = settings.dim && settings.dimScope === 'all' ? '' : popupFilter;
  for (var s = 0; s < settingsPopups.length; s++) {
    document.getElementById(settingsPopups[s]).style.filter = settingsFilter;
  }
  for (var i = 0; i < upperPopups.length; i++) {
    document.getElementById(upperPopups[i]).style.filter = popupFilter;
  }
  for (var j = 0; j < lowerPopups.length; j++) {
    document.getElementById(lowerPopups[j]).style.filter = lowerFilter;
  }
  // Only the filter: drawDiagnostics() would also push a graph sample and measure
  // the download rate over a few milliseconds, spiking the 60s graphs.
  var diag = document.getElementById('diagnostics');
  if (diag) diag.style.filter = settings.dim && settings.dimScope !== 'all' ? popupFilter : '';
  if (state.notifyCurrent) {
    document.getElementById('notify').style.filter =
      settings.dim && settings.dimScope !== 'all' ? popupFilter : '';
  }
}
// Make a toggle take effect right away.
function applyToggle(key) {
  if (key === 'chat') {
    syncChat();
    toast('Live chat ' + (settings.chat ? 'on' : 'off'));
  } else if (key === 'lowlatency') {
    toast('Low latency ' + (settings.lowlatency ? 'on' : 'off'));
    // a deliberate settings reload must not eat into the fatal-failure budget
    if (state.current) { PB.recoverCount = 0; recoverPlayback(state.current); }
  } else if (key === 'autoadvance') {
    toast('Auto-advance ' + (settings.autoadvance ? 'on' : 'off'));
  } else if (key === 'hideOffline') {
    state.offlineExpanded = false;
    if (state.sidebarOpen) renderSidebar(settings.hideOffline ? 'offline-group' : state.current);
    toast('Hide offline channels ' + (settings.hideOffline ? 'on' : 'off'));
  } else if (key === 'hideBots') {
    if (browse.open) { browse.gridIdx = 0; browse.renderLimit = 60; renderBrowse(); }
    toast('Bot streams ' + (settings.hideBots ? 'hidden' : 'shown'));
  } else if (key === 'diagnostics') {
    syncDiagnostics();
    toast('Diagnostics overlay ' + (settings.diagnostics ? 'on' : 'off'));
  }
}

/* Compact quality picker, opened from the dedicated bottom-right player tool. */
var qualityopt = { open: false, focus: 0, items: [] };
function qualityCurrentLabel() {
  if (quality.sel === 'auto') return 'Auto';
  var rows = qualityRows();
  var effective = levelIndexForPref();
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i].auto && rows[i].idx === effective) return rows[i].label;
  }
  return quality.sel + 'p';
}
function maxQualityLevelIndex() {
  if (!state.hls || !state.hls.levels || !state.hls.levels.length) return -1;
  var levels = state.hls.levels, best = 0, bestH = -1, bestRate = -1;
  for (var i = 0; i < levels.length; i++) {
    var h = levels[i].height || 0, rate = levels[i].bitrate || 0;
    if (h > bestH || (h === bestH && rate > bestRate)) {
      best = i; bestH = h; bestRate = rate;
    }
  }
  return best;
}
function playingQualityLevelIndex() {
  if (!state.hls || !state.hls.levels || !state.hls.levels.length) return -1;
  var candidates = [];
  try {
    // Prefer the level that HLS is really decoding/loading. This matters while
    // a fixed-quality switch is still pending: the bars must describe what is
    // on screen, not merely the requested target.
    candidates = [state.hls.currentLevel, state.hls.loadLevel];
  } catch (e) {}
  for (var i = 0; i < candidates.length; i++) {
    if (typeof candidates[i] === 'number' &&
        candidates[i] >= 0 && candidates[i] < state.hls.levels.length) return candidates[i];
  }
  if (quality.sel !== 'auto') return levelIndexForPref();
  try {
    candidates = [state.hls.nextLoadLevel, state.hls.nextAutoLevel];
  } catch (e2) { candidates = []; }
  for (var j = 0; j < candidates.length; j++) {
    if (typeof candidates[j] === 'number' &&
        candidates[j] >= 0 && candidates[j] < state.hls.levels.length) return candidates[j];
  }
  return -1;
}
function qualityPlaybackStatus() {
  var hls = state.hls, levels = hls && hls.levels;
  if (!levels || !levels.length) {
    return { known: false, tone: 'unknown', bars: 0,
             text: 'Source quality is still loading.' };
  }
  var maxIdx = maxQualityLevelIndex(), currentIdx = playingQualityLevelIndex();
  var maxLabel = qualityLevelLabel(levels[maxIdx]);
  if (currentIdx < 0 || !levels[currentIdx]) {
    return { known: false, tone: 'unknown', bars: 0,
             text: 'Quality is loading · Source max ' + maxLabel };
  }
  var current = levels[currentIdx], currentLabel = qualityLevelLabel(current);
  var atMax = currentIdx === maxIdx;
  var low = !!(current.height && current.height <= 480);
  var tone = low ? 'low' : (atMax ? 'max' : 'limited');
  return {
    known: true,
    tone: tone,
    bars: low ? 1 : (atMax ? 3 : 2),
    currentLabel: currentLabel,
    maxLabel: maxLabel,
    text: atMax
      ? ('Max quality · ' + maxLabel)
      : ('Playing ' + currentLabel + ' · Source max ' + maxLabel)
  };
}
/* Quality drop alert. When the stream plays below what was asked for (a fixed
   quality), or below the source's best (Auto), the Quality button shows by itself
   for a few seconds with the bars and the resolution actually playing. A stream's
   first seconds are ignored, since Auto always starts low and climbs, and a drop
   must last a moment before it counts. One alert per drop: it re-arms once
   quality recovers or falls further. */
var QUALITY_ALERT_MS = 5000, QUALITY_ALERT_GRACE_MS = 8000, QUALITY_ALERT_SETTLE_MS = 2000;
var qualityAlert = { from: 0, settle: null, hide: null, grace: null, showing: false, alertedIdx: -1 };
function qualityAlertReset() {
  qualityAlert.from = Date.now() + QUALITY_ALERT_GRACE_MS;
  qualityAlert.alertedIdx = -1;
  clearTimeout(qualityAlert.settle); qualityAlert.settle = null;
  // A stream that never climbs sends no switch event after the grace; look once then.
  clearTimeout(qualityAlert.grace);
  qualityAlert.grace = setTimeout(checkQualityDrop, QUALITY_ALERT_GRACE_MS);
  endQualityAlert();
}
// The level being played if it is below the target, else -1.
function qualityDropLevel() {
  var levels = state.hls && state.hls.levels;
  if (!levels || !levels.length) return -1;
  var cur = playingQualityLevelIndex();
  var target = quality.sel === 'auto' ? maxQualityLevelIndex() : levelIndexForPref();
  if (cur < 0 || target < 0 || cur === target) return -1;
  var a = levels[cur], b = levels[target], ah = a.height || 0, bh = b.height || 0;
  return ah < bh || (ah === bh && (a.bitrate || 0) < (b.bitrate || 0)) ? cur : -1;
}
function checkQualityDrop() {
  if (!settings.qualityAlert) return;
  var idx = qualityDropLevel();
  if (idx === -1) { qualityAlert.alertedIdx = -1; return; }       // recovered: re-arm
  if (qualityAlert.settle) return;
  qualityAlert.settle = setTimeout(function () {
    qualityAlert.settle = null;
    var now = qualityDropLevel();
    if (now === -1 || Date.now() < qualityAlert.from) return;
    var levels = state.hls.levels, prev = levels[qualityAlert.alertedIdx];
    // Already told about this drop, and it has not got worse.
    if (prev && (levels[now].height || 0) >= (prev.height || 0)) return;
    qualityAlert.alertedIdx = now;
    showQualityAlert();
  }, QUALITY_ALERT_SETTLE_MS);
}
function showQualityAlert() {
  var tools = document.getElementById('player-tools');
  if (!tools || !settings.qualityAlert || state.sidebarOpen || state.mode !== 'player' || anyPanelOpen() || saver.on || document.hidden) return;
  qualityAlert.showing = true;
  tools.classList.add('qalert');
  tools.classList.remove('hidden');
  updateQualityButton();
  clearTimeout(qualityAlert.hide);
  qualityAlert.hide = setTimeout(endQualityAlert, QUALITY_ALERT_MS);
}
function endQualityAlert() {
  clearTimeout(qualityAlert.hide); qualityAlert.hide = null;
  if (!qualityAlert.showing) return;
  qualityAlert.showing = false;
  var tools = document.getElementById('player-tools');
  if (tools) {
    tools.classList.remove('qalert');
    if (!state.sidebarOpen) tools.classList.add('hidden');
  }
  updateQualityButton();
}
function hideQualityHint() {
  var hint = document.getElementById('quality-hint');
  if (hint) hint.className = 'hidden';
}
function showQualityHint() {
  var hint = document.getElementById('quality-hint');
  var button = document.getElementById('quality-button');
  if (!hint || !button || !state.sidebarOpen || qualityopt.open) {
    hideQualityHint();
    return;
  }
  var status = qualityPlaybackStatus();
  hint.textContent = status.text;
  hint.style.filter = popupDimFilter();
  hint.className = status.tone;
  var r = button.getBoundingClientRect();
  var left = r.left + (r.width - hint.offsetWidth) / 2;
  left = Math.max(24, Math.min(1920 - hint.offsetWidth - 24, left));
  var top = Math.max(24, r.top - hint.offsetHeight - 20);
  var arrowLeft = r.left + r.width / 2 - left;
  arrowLeft = Math.max(24, Math.min(hint.offsetWidth - 24, arrowLeft));
  hint.style.left = Math.round(left) + 'px';
  hint.style.top = Math.round(top) + 'px';
  hint.style.setProperty('--quality-arrow-left', Math.round(arrowLeft) + 'px');
}
function updateQualityButton() {
  var el = document.getElementById('quality-button-value');
  var button = document.getElementById('quality-button');
  var mark = button && button.querySelector('.quality-mark');
  var status = qualityPlaybackStatus();
  // During a drop alert the button says what is actually playing, not the setting.
  var alerting = qualityAlert.showing && status.known;
  if (el) el.textContent = alerting ? status.currentLabel : qualityCurrentLabel();
  if (button) {
    button.classList.toggle('quality-limited', status.tone === 'limited');
    button.classList.toggle('quality-low', status.tone === 'low');
    button.setAttribute('title', status.text);
  }
  if (mark) {
    mark.className = 'player-tool-icon quality-mark q' + status.tone + ' qlevel-' + status.bars;
  }
  var hint = document.getElementById('quality-hint');
  if (hint && hint.className.indexOf('hidden') === -1) showQualityHint();
}
function refreshQualityOpt() {
  qualityopt.items = qualityRows();
  qualityopt.focus = 0;
  for (var i = 0; i < qualityopt.items.length; i++) {
    if (qualityIsSel(qualityopt.items[i])) { qualityopt.focus = i; break; }
  }
  renderQualityOpt();
}
function openQualityOpt() {
  if (!state.ready || qualityopt.open) return;
  qualityopt.open = true;
  clearTimeout(state.idleTimer);                 // keep the launch tools behind the modal
  hideQualityHint();
  sidePreviewCard.cancel();
  document.getElementById('settings-desc').className = 'hidden';
  document.getElementById('qualityoptmodal').className = '';
  refreshQualityOpt();
  if (window.UIPolish) UIPolish.place('qualityoptbox');
  touchSettings();
}
function closeQualityOpt() {
  qualityopt.open = false;
  clearTimeout(settingDescTimer);
  document.getElementById('settings-desc').className = 'hidden';
  document.getElementById('qualityoptmodal').className = 'hidden';
  updateQualityButton();
  if (state.sidebarOpen && !settings.open) scheduleSidePreview();
  if (!settings.open) {
    clearTimeout(settingsIdleTimer);
    settingsIdleTimer = null;
    if (state.sidebarOpen) resetIdle();
    pumpNotify();
  }
}
function renderQualityOpt() {
  var list = document.getElementById('qualityopt-list');
  var selectedMarked = false;
  list.innerHTML = '';
  qualityopt.items.forEach(function (row, i) {
    var selected = !selectedMarked && qualityIsSel(row);
    if (selected) selectedMarked = true;
    var el = document.createElement('div');
    el.className = 'qpick' + (selected ? ' selected' : '') + (i === qualityopt.focus ? ' focused' : '');
    el.setAttribute('data-idx', i);
    var label = document.createElement('span'); label.className = 'qpick-label'; label.textContent = row.label;
    var check = document.createElement('span'); check.className = 'qpick-check';
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    el.appendChild(label); el.appendChild(check);
    list.appendChild(el);
  });
  list._focusRow = list.children[qualityopt.focus] || null;
  renderQualityAlertSwitch();
  describeQualityOpt();
}
// The header switch. qualityopt.focus of -1 means it holds the focus.
function renderQualityAlertSwitch() {
  var sw = document.getElementById('qualityopt-alert');
  if (!sw) return;
  var cls = (settings.qualityAlert ? 'on' : '') + (qualityopt.focus === -1 ? ' focused' : '');
  if (sw.className !== cls) sw.className = cls;
  sw.setAttribute('aria-checked', settings.qualityAlert ? 'true' : 'false');
}
function qualityoptMove(delta) {
  var cur = qualityopt.focus, next = cur + delta, n = qualityopt.items.length;
  if (next < -1 || next >= n || next === cur) return;   // -1: the Alert switch above the list
  qualityopt.focus = next;
  var list = document.getElementById('qualityopt-list');
  if (list.children[cur]) list.children[cur].classList.remove('focused');
  if (next === -1) {
    if (list._focusRow) list._focusRow.classList.remove('focused');
    list._focusRow = null;
  } else focusPanelRow(list, next);
  renderQualityAlertSwitch();
  describeQualityOpt();
}
var QUALITY_ALERT_DESC = 'Briefly shows the quality button when the stream drops below the quality you picked.';
// Only the Alert switch needs explaining; the resolutions speak for themselves.
function describeQualityOpt() {
  var onSwitch = qualityopt.focus === -1;
  showSettingDesc('settings-desc', onSwitch ? QUALITY_ALERT_DESC : '',
    onSwitch ? document.getElementById('qualityopt-alert') : null, 'quality');
}
function toggleQualityAlert() {         // flips in place; the picker stays open
  settings.qualityAlert = !settings.qualityAlert;
  saveSettings();
  if (!settings.qualityAlert) endQualityAlert();
  renderQualityAlertSwitch();
  toast('Quality alert: ' + (settings.qualityAlert ? 'On' : 'Off'));
}
function qualityoptActivate() {
  if (qualityopt.focus === -1) { toggleQualityAlert(); return; }
  var row = qualityopt.items[qualityopt.focus];
  if (!row) return;
  pickQuality(row);
  toast('Quality: ' + row.label);
  closeQualityOpt();
}

/* Dim (night) options popup, opened from the Settings "Dim" row. Strength and
   scope are always saved; remembering the on/off state is explicitly opt-in. */
var dimopt = { open: false, focus: 0 };
var DIM_LEVELS = [ { label: 'Light', v: 0.4 }, { label: 'Medium', v: 0.6 }, { label: 'Strong', v: 0.8 }, { label: 'Max', v: 0.94 } ];
function dimStrengthLabel() {
  for (var i = 0; i < DIM_LEVELS.length; i++) if (Math.abs(DIM_LEVELS[i].v - settings.dimStrength) < 0.03) return DIM_LEVELS[i].label;
  return Math.round(settings.dimStrength * 100) + '%';
}
function openDimOpt() {
  dimopt.open = true; dimopt.focus = 0;
  document.getElementById('dimoptmodal').className = '';
  renderDimOpt();
  if (window.UIPolish) UIPolish.place('dimoptbox');
  touchSettings();
}
function closeDimOpt() {
  dimopt.open = false;
  document.getElementById('dimoptmodal').className = 'hidden';
  if (settings.open) renderSettings();     // refresh the On/Off shown on the Dim row
}
function renderDimOpt() {
  var rows = [
    { label: 'Dim', value: settings.dim ? 'On' : 'Off', on: settings.dim },
    { label: 'Strength', choices: DIM_LEVELS },
    { label: 'Dim everything', on: settings.dimScope === 'all' },
    { label: 'Remember dim', value: settings.rememberDim ? 'On' : 'Off', on: settings.rememberDim }
  ];
  var list = document.getElementById('dimopt-list');
  list.innerHTML = '';
  rows.forEach(function (r, i) {
    var el = document.createElement('div');
    el.className = 'srow' + (i === dimopt.focus ? ' focused' : '');
    el.setAttribute('data-idx', i);
    var lab = document.createElement('span'); lab.className = 'slabel'; lab.textContent = r.label;
    var pill;
    if (typeof r.on === 'boolean') pill = settingSwitch(r.label, r.on);
    else pill = settingChoices(r.label, r.choices, DIM_LEVELS.reduce(function (nearest, level) { return Math.abs(level.v - settings.dimStrength) < Math.abs(nearest.v - settings.dimStrength) ? level : nearest; }).v, function (index) {
      dimopt.focus = i; settings.dimStrength = DIM_LEVELS[index].v; saveSettings(); applyDim(); renderDimOpt();
    });
    el.appendChild(lab); el.appendChild(pill);
    list.appendChild(el);
  });
  showSettingDesc('settings-desc', DIMOPT_DESC[dimopt.focus] || '', list.children[dimopt.focus]);
}
function dimoptMove(delta) {
  var n = dimopt.focus + delta;
  if (n < 0 || n >= DIMOPT_DESC.length) return;
  dimopt.focus = n;
  var list = document.getElementById('dimopt-list');
  var old = list.querySelector('.focused');
  if (old) old.classList.remove('focused');
  showSettingDesc('settings-desc', DIMOPT_DESC[n], focusPanelRow(list, n));
}
// Step the dim strength to the next (dir +1) or previous (dir -1) level, and apply/save it.
function cycleDimStrength(dir) {
  dir = dir || 1;
  var idx = 0, n = DIM_LEVELS.length;
  for (var i = 0; i < n; i++) if (Math.abs(DIM_LEVELS[i].v - settings.dimStrength) < 0.03) { idx = i; break; }
  settings.dimStrength = DIM_LEVELS[((idx + dir) % n + n) % n].v;
  saveSettings();
  applyDim();
}
function dimoptActivate(dir) {
  if (dimopt.focus === 0) { settings.dim = !settings.dim; saveSettings(); applyDim(); }
  else if (dimopt.focus === 1) cycleDimStrength(dir);
  else if (dimopt.focus === 2) {
    settings.dimScope = settings.dimScope === 'all' ? 'video' : 'all';
    saveSettings();
    applyDim();
  } else {
    settings.rememberDim = !settings.rememberDim;
    saveSettings();
  }
  renderDimOpt();
}
// The "0" remote button: a quick toggle for dim. While the dim info popup is
// still on screen, further presses walk the cycle Light -> Medium -> Strong ->
// Max -> Off -> Light...; once the popup has gone, the next press is a plain
// on/off toggle again. The popup's own lifetime IS the rapid-press window.
var dimToastShowing = false;   // any other toast replacing ours also ends the window
function dimQuickKey() {
  var rapid = dimToastShowing &&
    document.getElementById('toast').className.indexOf('hidden') === -1;
  if (rapid && settings.dim) {
    var idx = 0;
    for (var i = 0; i < DIM_LEVELS.length; i++) {
      if (Math.abs(DIM_LEVELS[i].v - settings.dimStrength) < 0.03) { idx = i; break; }
    }
    if (idx >= DIM_LEVELS.length - 1) {          // past Max the cycle reaches Off
      settings.dim = false;
      toast('Dim off');
    } else {
      settings.dimStrength = DIM_LEVELS[idx + 1].v;
      toast('Dim: ' + dimStrengthLabel());
    }
  } else if (rapid && !settings.dim) {           // keep cycling: wrap from Off to Light
    settings.dim = true;
    settings.dimStrength = DIM_LEVELS[0].v;
    toast('Dim on — ' + dimStrengthLabel());
  } else {
    settings.dim = !settings.dim;
    toast(settings.dim ? ('Dim on — ' + dimStrengthLabel()) : 'Dim off');
  }
  saveSettings();
  applyDim();
  dimToastShowing = true;      // set after the toast() above, so it survives the reset
  if (dimopt.open) renderDimOpt();
  if (settings.open) renderSettings();     // keep the Dim row's On/Off in sync if it's showing
}

/* Live chat options popup, opened from the chat toolbar or Settings. */
var chatopt = { open: false, focus: 0 };
var CHATOPT_ROWS = [
  { key: 'chat',           label: 'Chat',         bool: true, desc: 'Green toggles live chat. The latest 160 messages stay until replaced by newer ones or you leave the channel.' },
  { key: 'chatSeparate',   label: 'Separate chat', bool: true, desc: 'Fit the stream beside chat when docked left or right. Drag the inside edge to adjust the width. Floating chat stays over the stream.' },
  { key: 'chatResizePreview', label: 'Resize preview', bool: true, desc: 'Use an outline while resizing docked chat. The video resizes once when you release, which is lighter on the TV.' },
  { key: 'chatBackground', label: 'White background', vals: [['black', 'Black'], ['white', 'White']], desc: 'On uses white; off uses black. Adjust transparency below. Text adapts to a light or dark background.' },
  { key: 'chatTransparency', label: 'Background transparency', range: { id: 'chat-transparency', max: 100, remoteStep: 5 }, desc: 'Drag the slider for any value from 0% (solid) to 100% (clear). Left and Right adjust by 5%. The message text keeps its own opacity.' },
  { key: 'chatSize',       label: 'Text size',    vals: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], desc: 'Font size of chat messages.' },
  { key: 'chatOpacity',    label: 'Text opacity', vals: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], desc: 'Adjust message transparency. Controls stay fully visible when you point at chat.' },
  { key: 'chatDelay',      label: 'Message delay', range: { id: 'chat-delay', min: -1, max: 60, remoteStep: 1 }, desc: 'Auto holds each message until the video reaches the moment it was sent, so chat stays in step with the picture. Or pick Off, or a fixed 1 to 60 seconds.' },
  { key: 'chatBots',       label: 'Hide bot messages', vals: [['show', 'Show'], ['hide', 'Hide']], desc: 'Hide messages from known bots and chat !commands.' },
  { key: 'chatEmotes',     label: 'Emote images', vals: [['text', 'Text'], ['images', 'Images']], desc: 'Show emotes as their real images, or just their names as text.' },
  { key: 'chatTimestamps', label: 'Timestamps',   bool: true, desc: 'Show the time before each message.' },
  { key: 'chatReset',      label: 'Reset this layout', action: true, desc: 'Restore the default size and position for this channel. Other channels and message options stay the same.' }
];
function chatoptValLabel(row) {
  if (row.action) return 'Reset';
  if (row.key === 'chatDelay') return settings.chatDelay < 0 ? 'Auto' : (settings.chatDelay ? settings.chatDelay + 's' : 'Off');
  if (row.range) return settings[row.key] + '%';
  if (row.bool) return settings[row.key] ? 'On' : 'Off';
  for (var i = 0; i < row.vals.length; i++) if (row.vals[i][0] === settings[row.key]) return row.vals[i][1];
  return '';
}
function openChatOpt() {
  if (!chatStreamerSlug()) { toast('Choose a streamer first'); return; }
  applyStreamerChatPreferences();
  sidePreviewCard.cancel();
  chatopt.open = true; chatopt.focus = 0;
  document.getElementById('chatoptbox').style.left = ChatWindow.side() === 'right' ? '80px' : '1300px';
  document.getElementById('chatoptmodal').className = '';
  renderChatOpt();
  if (window.UIPolish) UIPolish.place('chatoptbox');
  touchSettings();
}
function closeChatOpt() {
  saveSettings();
  chatopt.open = false;
  document.getElementById('chatoptmodal').className = 'hidden';
  if (settings.open) renderSettings();     // refresh the Live chat On/Off pill behind it
  else {
    clearTimeout(settingsIdleTimer); settingsIdleTimer = null;
    document.getElementById('settings-desc').className = 'hidden';
    if (state.sidebarOpen) scheduleSidePreview();
  }
}
function renderChatOpt() {
  var slug = chatStreamerSlug(), channel = state.channels[slug];
  var name = channel && channel.name || (state.vod && state.vod.slug === slug && state.vod.name) || slug;
  if (window.UIPolish) UIPolish.chatIdentity(name, channel && channel.avatar);
  document.getElementById('chatopt-note').textContent = 'These settings apply only to ' + name + '.';
  var list = document.getElementById('chatopt-list');
  list.innerHTML = '';
  CHATOPT_ROWS.forEach(function (row, i) {
    var el = document.createElement('div');
    el.className = 'srow' + (row.range ? ' chat-range-row' : '') + (i === chatopt.focus ? ' focused' : '');
    el.setAttribute('data-idx', i);
    var binary = row.bool || (row.vals && row.vals.length === 2);
    var on = row.bool ? !!settings[row.key] : !!(binary && settings[row.key] === row.vals[1][0]);
    var lab = document.createElement('span'); lab.className = 'slabel'; lab.textContent = row.label;
    var pill;
    if (binary) pill = settingSwitch(row.label, on);
    else if (row.vals) pill = settingChoices(row.label, row.vals, settings[row.key], function (index) {
      chatopt.focus = i; settings[row.key] = row.vals[index][0]; saveSettings(); applyChatStyle(); renderChatOpt();
    });
    else { pill = document.createElement('span'); pill.className = 'spill'; pill.textContent = chatoptValLabel(row); }
    el.appendChild(lab); el.appendChild(pill);
    if (row.range) {
      var slider = document.createElement('input');
      slider.id = row.range.id; slider.type = 'range'; slider.className = 'chat-setting-slider';
      slider.min = String(row.range.min || 0); slider.max = String(row.range.max); slider.step = '1';
      slider.value = settings[row.key]; slider.tabIndex = -1;
      slider.setAttribute('aria-label', row.label);
      slider.addEventListener('input', function () { chatopt.focus = i; applyChatOptFocus(true); setChatRange(row, this.value, false); });
      slider.addEventListener('change', function () { setChatRange(row, this.value, true); });
      el.appendChild(slider);
    }
    list.appendChild(el);
  });
  CHATOPT_ROWS.forEach(function (row) { if (row.range) paintChatRange(row); });
  applyChatOptFocus();
}
function applyChatOptFocus(preserveScroll) {
  var list = document.getElementById('chatopt-list');
  for (var i = 0; i < list.children.length; i++) list.children[i].classList.toggle('focused', i === chatopt.focus);
  var f = list.children[chatopt.focus];
  if (f && !preserveScroll) scrollIntoViewport(list, f, 6);
  showSettingDesc('settings-desc', (CHATOPT_ROWS[chatopt.focus] || {}).desc || '', f);
}
function chatoptMove(delta) { var n = chatopt.focus + delta; if (n < 0 || n >= CHATOPT_ROWS.length) return; chatopt.focus = n; applyChatOptFocus(); }
function paintChatRange(row) {
  var slider = document.getElementById(row.range.id);
  if (!slider) return;
  var min = row.range.min || 0, value = settings[row.key];
  var percent = (value - min) / (row.range.max - min) * 100;
  slider.value = value;
  slider.style.backgroundImage = 'linear-gradient(to right, #53fc18 ' + percent + '%, #4a5156 ' + percent + '%)';
  slider.setAttribute('aria-valuetext', row.key === 'chatDelay' ?
    (value < 0 ? 'Auto' : (value ? value + (value === 1 ? ' second' : ' seconds') : 'Off')) : value + '% transparent');
  slider.parentNode.querySelector('.spill').textContent = chatoptValLabel(row);
}
function setChatRange(row, value, persist) {
  settings[row.key] = Math.max(row.range.min || 0, Math.min(row.range.max, Math.round(Number(value) || 0)));
  paintChatRange(row);
  if (row.key === 'chatDelay') rescheduleChatDelay();
  else applyChatStyle();
  touchSettings();
  if (persist) saveSettings();
}
function chatoptActivate(dir) {
  dir = dir || 1;
  var row = CHATOPT_ROWS[chatopt.focus];
  if (row.action) { ChatWindow.reset(); renderChatOpt(); return; }
  if (row.range) { setChatRange(row, settings[row.key] + dir * row.range.remoteStep, true); return; }
  if (row.bool) {
    if (row.key === 'chat' && !settings.chat && !chatCanTurnOn()) return;
    settings[row.key] = !settings[row.key];
  } else {
    var idx = 0, n = row.vals.length;
    for (var i = 0; i < n; i++) if (row.vals[i][0] === settings[row.key]) { idx = i; break; }
    settings[row.key] = row.vals[((idx + dir) % n + n) % n][0];
  }
  saveSettings();
  if (row.key === 'chat') syncChat();        // connect/disconnect the chat socket
  applyChatStyle();                          // appearance and video layout update immediately
  renderChatOpt();
}

/* Blocked categories popup, opened from the Settings row. Each row unblocks. */
var blockedcats = { open: false, focus: 0, items: [] };
function openBlockedCats() {
  blockedcats.open = true;
  blockedcats.items = getBlockedCats().slice();
  blockedcats.focus = 0;
  document.getElementById('blockedcatsmodal').className = '';
  renderBlockedCats();
  touchSettings();
}
function closeBlockedCats() {
  blockedcats.open = false;
  document.getElementById('blockedcatsmodal').className = 'hidden';
  if (settings.open) renderSettings();     // refresh the count on the row behind it
}
// The link row always sits last, including when nothing is blocked — that is
// exactly when the user needs telling where the block button lives.
function blockedcatsLinkIndex() { return blockedcats.items.length; }
function renderBlockedCats() {
  blockedcats.items = getBlockedCats().slice();
  var list = document.getElementById('blockedcats-list');
  list.innerHTML = '';
  if (blockedcats.focus > blockedcatsLinkIndex()) blockedcats.focus = blockedcatsLinkIndex();
  if (!blockedcats.items.length) {
    var empty = document.createElement('div');
    empty.className = 'bcatempty';
    empty.textContent = 'No blocked categories';
    list.appendChild(empty);
  } else {
    blockedcats.items.forEach(function (c, i) {
      var el = document.createElement('div');
      el.className = 'bcatrow' + (i === blockedcats.focus ? ' focused' : '');
      el.setAttribute('data-idx', i);
      var lab = document.createElement('span'); lab.className = 'slabel';
      lab.textContent = c.name || c.slug;
      var x = document.createElement('span'); x.className = 'bcatx'; x.textContent = '✕';
      el.appendChild(lab); el.appendChild(x);
      list.appendChild(el);
    });
  }
  var link = document.createElement('div');
  link.className = 'bcatrow bcatlink' + (blockedcats.focus === blockedcatsLinkIndex() ? ' focused' : '');
  link.setAttribute('data-idx', String(blockedcatsLinkIndex()));
  var llab = document.createElement('span'); llab.className = 'slabel';
  llab.textContent = 'Block a category — open Categories';
  var chev = document.createElement('span'); chev.className = 'bcatchev'; chev.textContent = '›';
  link.appendChild(llab); link.appendChild(chev);
  list.appendChild(link);

  var f = list.children[blockedcats.focus] || list.lastChild;
  if (f) scrollIntoViewport(list, f, 6);
  showSettingDesc('settings-desc', SETTINGS_DESC.blockedcats, f);
}
function blockedcatsMove(delta) {
  var n = blockedcats.focus + delta;
  if (n < 0 || n > blockedcatsLinkIndex()) return;
  blockedcats.focus = n;
  renderBlockedCats();
}
function blockedcatsActivate() {
  if (blockedcats.focus === blockedcatsLinkIndex()) {   // the shortcut, not an unblock
    closeBlockedCats();
    closeSettingsStack();
    openBrowse();
    openCats();                                        // openBrowse sets browse.open first
    return;
  }
  var c = blockedcats.items[blockedcats.focus];
  if (!c) return;
  toggleCatBlock(c.slug, c.name);          // it is blocked, so this unblocks it
  toast('Unblocked ' + (c.name || c.slug));
  applyBlockedChange();
  renderBlockedCats();
}

/* Update check. Compare our appinfo version to the latest GitHub release. A
   sandboxed webOS app cannot install anything itself, so this only flags a red
   dot on the gear and shows the release notes; the user re-sideloads manually. */
var updateInfo = null;      // { version, notes } once a newer release is found
var updateopen = false;
var appVersion = '';        // our own version, shown as a chip in the Settings header
var GH_LATEST = 'https://api.github.com/repos/barisahmet/kick-tv-webos/releases/latest';
// The version chip at the right of the Settings title: muted "vX" when current,
// a clickable yellow "New" chip (opens the release notes) when an update is out.
function renderSettingsVer() {
  var el = document.getElementById('settings-ver');
  if (!el) return;
  if (!appVersion) { el.className = 'hidden'; return; }
  el.textContent = 'v' + appVersion;                 // always the installed version
  el.className = updateInfo ? 'hasnew' : '';          // yellow + "New" badge when a newer release exists
}
function loadAppVersion() {
  var x = new XMLHttpRequest();
  x.open('GET', 'appinfo.json', true);
  x.onload = function () {
    try { appVersion = JSON.parse(x.responseText).version || ''; } catch (e) {}
    if (settings.open) renderSettingsVer();
  };
  x.onerror = function () {};
  x.send();
}
function isNewerVersion(a, b) {
  var pa = String(a).split('.'), pb = String(b).split('.');
  for (var i = 0; i < 3; i++) {
    var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x > y;
  }
  return false;
}
function checkForUpdate() {
  var xi = new XMLHttpRequest();
  xi.open('GET', 'appinfo.json', true);
  xi.onload = function () {
    var cur; try { cur = JSON.parse(xi.responseText).version; } catch (e) { return; }
    appVersion = cur;
    if (settings.open) renderSettingsVer();
    var xg = new XMLHttpRequest();
    xg.open('GET', GH_LATEST, true);
    xg.onload = function () {
      if (xg.status !== 200) return;
      var rel; try { rel = JSON.parse(xg.responseText); } catch (e) { return; }
      var latest = (rel.tag_name || '').replace(/^v/, '');
      if (latest && isNewerVersion(latest, cur)) {
        updateInfo = { version: latest, notes: rel.body || '' };
        var g = document.getElementById('settings-button');
        if (g) g.classList.add('hasupdate');
        if (settings.open) { settings.items = settingsBuild(); renderSettings(); renderSettingsVer(); }
      }
    };
    xg.timeout = 12000;
    xg.onerror = xg.ontimeout = function () {};
    xg.send();
  };
  xi.onerror = function () {};
  xi.send();
}
// Lightly de-markdown the release notes for plain-text display on the TV.
function stripMd(s) {
  return String(s || '').replace(/\r/g, '')
    .replace(/^#+\s*/gm, '').replace(/\*\*/g, '')
    .replace(/^\s*-\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^---+\s*$/gm, '').trim();
}
function openUpdateNotes() {
  if (!updateInfo) return;
  updateopen = true;
  document.getElementById('settings-desc').className = 'hidden';
  document.getElementById('update-ver').textContent = 'Version ' + updateInfo.version;
  document.getElementById('update-notes').textContent = stripMd(updateInfo.notes);
  document.getElementById('updatemodal').className = '';
  touchSettings();
}
function closeUpdateNotes() {
  updateopen = false;
  document.getElementById('updatemodal').className = 'hidden';
  if (settings.open) applySettingsFocus();
}

