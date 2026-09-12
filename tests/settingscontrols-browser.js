window.runSettingscontrolsTests = async function (assert) {
  function el(id) { return document.getElementById(id); }
  function key(code) { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, keyCode: code })); }
  function click(node) { assert(!!node, 'setting control exists'); node.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  function row(name) { return el('settings-list').children[settings.items.map(function (it) { return it.key || it.kind; }).indexOf(name)]; }
  function wheel(node, delta) {
    var event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: delta, clientX: 1450, clientY: 300 });
    node.dispatchEvent(event); return event;
  }
  function hover(node, type, y) { node.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 1450, clientY: y })); }
  openSettings();
  var list = el('settings-list'); list.style.maxHeight = '360px';
  hover(list.children[0], 'mouseover', 300);
  var focused = settings.focus, first = list.children[0], oldTop = list.scrollTop;
  wheel(first, 120);
  assert(list.scrollTop > oldTop && settings.focus === focused, 'remote wheel scrolls Settings without changing focus');
  hover(list.children[1], 'mouseover', 300); hover(list.children[1], 'mousemove', 300);
  assert(settings.focus === focused, 'stationary pointer events after wheel scrolling do not refocus rows');
  hover(list.children[1], 'mousemove', 320);
  assert(settings.focus === 1, 'moving the pointer deliberately resumes hover focus');
  key(40); assert(settings.focus === 2, 'D-pad Down still navigates settings rows');
  var unchanged = JSON.stringify(settingsBuild().map(function (it) { return settings[it.key]; }));
  wheel(list, -120);
  assert(JSON.stringify(settingsBuild().map(function (it) { return settings[it.key]; })) === unchanged, 'wheel scrolling does not edit settings');

  var alerts = row('alerts');
  click(alerts.querySelector('[data-value="pinned"]'));
  assert(settings.alerts === 'pinned' && JSON.parse(fixtureStore['kicktv.settings']).alerts === 'pinned', 'Live alerts pill selects and saves a specific choice');
  assert(row('alerts').querySelectorAll('[role="radio"][aria-checked="true"]').length === 1, 'Live alerts has one selected segment');
  key(39); assert(settings.alerts === 'off', 'Right advances the focused pill selection');
  key(37); assert(settings.alerts === 'pinned', 'Left selects the previous pill');

  var duration = row('notifySec').querySelector('input[type="range"]');
  assert(duration && duration.min === '5' && duration.max === '30' && duration.step === '1', 'Alert duration uses a 5–30 second slider');
  var savedDuration = JSON.parse(fixtureStore['kicktv.settings']).notifySec;
  duration.value = '12'; duration.dispatchEvent(new Event('input', { bubbles: true }));
  assert(settings.notifySec === 12 && JSON.parse(fixtureStore['kicktv.settings']).notifySec === savedDuration, 'duration dragging previews without writing every move');
  duration.dispatchEvent(new Event('change', { bubbles: true }));
  click(duration);
  assert(settings.notifySec === 12 && JSON.parse(fixtureStore['kicktv.settings']).notifySec === 12, 'slider release saves once without an extra click increment');
  key(39); assert(settings.notifySec === 13, 'remote Right adjusts alert duration by one second');
  key(37); assert(settings.notifySec === 12, 'remote Left adjusts alert duration by one second');
  var durationFocus = settings.focus;
  wheel(duration, 120);
  assert(settings.notifySec === 12 && settings.focus === durationFocus, 'wheel over a slider scrolls rather than editing its value or focus');
  assert(row('notifySec').querySelector('input') === duration, 'slider changes preserve the live input node');

  var guard = row('saverMin').querySelector('input[type="range"]');
  assert(guard && guard.min === '0' && guard.max === '10', 'Burn-in guard slider includes Off through ten minutes');
  guard.value = '0'; guard.dispatchEvent(new Event('input', { bubbles: true })); guard.dispatchEvent(new Event('change', { bubbles: true }));
  assert(settings.saverMin === 0 && guard.getAttribute('aria-valuetext') === 'Off', 'zero disables the burn-in guard');
  key(37); assert(settings.saverMin === 0, 'slider Left stops at the lower limit instead of wrapping');
  guard.value = '7'; guard.dispatchEvent(new Event('input', { bubbles: true })); guard.dispatchEvent(new Event('change', { bubbles: true }));
  loadSettings();
  assert(settings.notifySec === 12 && settings.saverMin === 7, 'intermediate slider values survive reloading saved settings');
  renderSettings();

  openDimOpt();
  click(el('dimopt-list').querySelector('[data-value="0.4"]'));
  assert(settings.dimStrength === 0.4 && JSON.parse(fixtureStore['kicktv.settings']).dimStrength === 0.4, 'Dim strength pills select the exact stored strength');
  el('dimopt-list').style.maxHeight = '130px'; var dimFocus = dimopt.focus;
  wheel(el('dimopt-list'), 120);
  assert(el('dimopt-list').scrollTop > 0 && dimopt.focus === dimFocus, 'Dim options scroll independently of focus');
  closeDimOpt(); openChatOpt();
  var sizeIndex = CHATOPT_ROWS.map(function (it) { return it.key; }).indexOf('chatSize');
  click(el('chatopt-list').children[sizeIndex].querySelector('[data-value="large"]'));
  assert(settings.chatSize === 'large', 'chat text size uses direct pill selection');
  var chatFocus = chatopt.focus, parentScroll = list.scrollTop;
  wheel(el('chatopt-list'), 120);
  assert(chatopt.focus === chatFocus && list.scrollTop === parentScroll, 'scrolling chat options leaves both focus and the parent menu alone');
  closeChatOpt(); state.current = 'beta'; applyStreamerChatPreferences();
  assert(settings.chatSize === 'medium', 'chat pill choices remain per streamer');
  state.current = 'alpha'; applyStreamerChatPreferences();
  assert(settings.chatSize === 'large', 'returning restores the streamer pill choice');

  settings.focus = settings.items.length - 1; applySettingsFocus();
  ['normal', 'large'].forEach(function (size) {
    settings.uiText = size; UIPolish.apply(); renderSettings();
    var group = row('alerts').querySelector('[role="radiogroup"]'), box = group.getBoundingClientRect();
    assert(box.right <= list.getBoundingClientRect().right && box.width > 0, size + ' choice pills fit inside Settings');
    assert(box.left > row('alerts').querySelector('.slabel').getBoundingClientRect().right, size + ' pills do not overlap their label');
  });
  settings.uiText = 'normal'; UIPolish.apply(); renderSettings();
  settings.focus = settings.items.map(function (it) { return it.key; }).indexOf('alerts'); applySettingsFocus();
};
