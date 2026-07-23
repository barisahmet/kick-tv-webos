'use strict';
/*
  Kick TV. This app opens on a stream instead of a menu. When it starts it
  plays the last channel you watched, or the first one that happens to be live,
  and the sidebar is where you do everything else, like watch, add, remove,
  pin, and refresh.

  It is written in plain old ES5 with XMLHttpRequest on purpose. The browser
  engine on older webOS TVs does not have fetch or newer JavaScript features.
*/

var PLAYER_REFRESH_MS = 30000; // how often we refresh the list while a stream plays

var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461,
            RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
            PLAY: 415, PAUSE: 19, STOP: 413 };

var state = {
  mode: 'player',        // which screen is showing: player, add, or confirm
  order: [],             // channel names in the order they appear in the list
  channels: {},          // channel name to the data we fetched for it
  hls: null,
  current: null,         // the channel playing right now, or null when nothing is on
  sidebarOpen: false,
  sideItems: [],         // the rows in the sidebar, with the Add row at the end
  sideFocus: 0,          // which sidebar row is highlighted
  playerTimer: null,
  toastTimer: null,
  idleTimer: null,       // closes the sidebar again once you stop touching it
  notifyTimer: null,
  wasLive: {},           // who was live last time, so we can tell when someone comes online
  baselineSet: false,    // the first load only records live status, so we do not alert for everyone
  netDown: false,        // true when the last refresh could not reach Kick at all
  downRetry: false,      // true while a quick retry is already queued, so we do not stack them
  ready: false,          // false until the first load finishes; the splash ignores input until then
  quitArmed: false,      // set after the first Back press, so the next Back exits
  quitTimer: null,
  tempChannel: null,     // a browsed channel that is playing but not in the follow list
  lastFetch: 0           // when favorites were last refreshed (to avoid redundant fetches)
};
var IDLE_MS = 5000;

// Playback state and the numbers that control how we recover from drops.
var PB = { slug: null, active: false, reloading: false,
           netRetries: 0, mediaRetries: 0,
           watchdog: null, reconnectTimer: null, lastTime: -1, stallCount: 0 };
var MAX_NET_RETRY = 6;     // quiet reload tries before we go fetch a brand new stream link
var MAX_MEDIA_RETRY = 3;   // decode recovery tries before we reload the whole stream
var WATCHDOG_MS = 5000;    // how often the freeze checker runs
var STALL_TICKS = 3;       // three checks with no progress, about fifteen seconds, counts as frozen

/* Favorites, pins, and last watched */
function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}
function getFavorites() {
  var removed = lsGet('kicktv.removed'), added = lsGet('kicktv.added'), favs = [];
  SEED_FAVORITES.forEach(function (s) { if (removed.indexOf(s) === -1) favs.push(s); });
  added.forEach(function (s) {
    if (favs.indexOf(s) === -1 && removed.indexOf(s) === -1) favs.push(s);
  });
  return favs;
}
function addFavorite(slug) {
  var added = lsGet('kicktv.added'), removed = lsGet('kicktv.removed');
  var ri = removed.indexOf(slug);
  if (ri !== -1) { removed.splice(ri, 1); lsSet('kicktv.removed', removed); }
  if (added.indexOf(slug) === -1 && SEED_FAVORITES.indexOf(slug) === -1) {
    added.push(slug); lsSet('kicktv.added', added);
  }
}
function removeFavorite(slug) {
  var added = lsGet('kicktv.added'), removed = lsGet('kicktv.removed');
  var ai = added.indexOf(slug);
  if (ai !== -1) { added.splice(ai, 1); lsSet('kicktv.added', added); }
  if (SEED_FAVORITES.indexOf(slug) !== -1 && removed.indexOf(slug) === -1) {
    removed.push(slug); lsSet('kicktv.removed', removed);
  }
  var pinned = lsGet('kicktv.pinned'), pi = pinned.indexOf(slug);
  if (pi !== -1) { pinned.splice(pi, 1); lsSet('kicktv.pinned', pinned); }
}
function isPinned(slug) { return lsGet('kicktv.pinned').indexOf(slug) !== -1; }
function togglePin(slug) {
  var pinned = lsGet('kicktv.pinned'), i = pinned.indexOf(slug);
  if (i === -1) pinned.push(slug); else pinned.splice(i, 1);
  lsSet('kicktv.pinned', pinned);
  return i === -1; // true if we just pinned it, false if we just unpinned it
}
function saveLast(slug) { try { localStorage.setItem('kicktv.last', slug); } catch (e) {} }
function loadLast() { try { return localStorage.getItem('kicktv.last'); } catch (e) { return null; } }

/* Talking to Kick */
function serviceGet(path, cb) {
  var Bridge = window.WebOSServiceBridge || window.PalmServiceBridge;
  if (!Bridge) { cb('nobridge'); return; }
  var bridge, done = false;
  try { bridge = new Bridge(); } catch (e) { cb('nobridge'); return; }
  var timer = setTimeout(function () { if (!done) { done = true; cb('timeout'); } }, 12000);
  bridge.onservicecallback = function (msg) {
    if (done) return;
    done = true; clearTimeout(timer);
    try {
      var r = JSON.parse(msg);
      if (r.ok && r.status === 200) cb(null, JSON.parse(r.body));
      else cb(r.status || r.error || 'service');
    } catch (e) { cb('parse'); }
  };
  try {
    bridge.call('luna://com.barisahmet.kicktv.service/fetch', JSON.stringify({ path: path }));
  } catch (e) {
    if (!done) { done = true; clearTimeout(timer); cb('callfail'); }
  }
}
function xhrGet(slug, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://kick.com/api/v2/channels/' + encodeURIComponent(slug), true);
  xhr.setRequestHeader('Accept', 'application/json');
  xhr.timeout = 10000;
  xhr.onload = function () {
    if (xhr.status === 200) { try { cb(null, JSON.parse(xhr.responseText)); return; } catch (e) {} }
    cb(xhr.status || 'parse');
  };
  xhr.onerror = xhr.ontimeout = function () { cb('network'); };
  xhr.send();
}
function apiGet(slug, cb) {
  var path = '/api/v2/channels/' + encodeURIComponent(slug);
  serviceGet(path, function (err, data) {
    if (!err) { cb(null, data); return; }
    if (err === 404) { cb(404); return; }
    // give it one more quick try before falling back, in case that was a hiccup
    setTimeout(function () {
      serviceGet(path, function (err2, data2) {
        if (!err2) { cb(null, data2); return; }
        if (err2 === 404) { cb(404); return; }
        xhrGet(slug, cb);
      });
    }, 700);
  });
}
function normalize(slug, raw) {
  var live = raw.livestream && raw.livestream.is_live;
  var cats = live && raw.livestream.categories;
  return {
    slug: slug,
    name: (raw.user && raw.user.username) || slug,
    avatar: (raw.user && raw.user.profile_pic) || null,
    live: !!live,
    viewers: live ? (raw.livestream.viewer_count || 0) : 0,
    title: live ? (raw.livestream.session_title || '') : '',
    category: cats && cats[0] ? (cats[0].name || '') : '',
    playbackUrl: raw.playback_url || null,
    chatroomId: (raw.chatroom && raw.chatroom.id) || null
  };
}
function offlineStub(slug) {
  return { slug: slug, name: slug, live: false, viewers: 0, title: '',
           category: '', avatar: null, playbackUrl: null, chatroomId: null };
}
// Order the list. Pinned channels that are live go first, then the rest of the
// live ones by viewer count, then everyone offline in alphabetical order. A pin
// only pulls a channel to the top while that channel is actually live.
function sortOrder(favs) {
  function grp(c) { return c.live ? (isPinned(c.slug) ? 0 : 1) : 2; }
  state.order = favs.slice().sort(function (a, b) {
    var ca = state.channels[a], cb2 = state.channels[b];
    var ga = grp(ca), gb = grp(cb2);
    if (ga !== gb) return ga - gb;
    if (ga === 2) return ca.name.toLowerCase() < cb2.name.toLowerCase() ? -1 : 1;
    return cb2.viewers - ca.viewers;
  });
}
function fetchFavorites(done) {
  var favs = getFavorites(), pending = favs.length, ok = 0;
  if (!pending) { state.order = []; state.baselineSet = true; setNetDown(false); done(); return; }
  favs.forEach(function (slug) {
    apiGet(slug, function (err, raw) {
      if (!err) { state.channels[slug] = normalize(slug, raw); ok++; }
      else if (!state.channels[slug]) state.channels[slug] = offlineStub(slug);
      if (--pending === 0) {
        state.lastFetch = Date.now();
        setNetDown(ok === 0);           // if nothing at all got through, treat it as offline
        sortOrder(favs); detectOnline(favs); done();
      }
    });
  });
}
function setNetDown(down) { state.netDown = down; }
// Watch for a channel going from offline to live and show a small alert. The
// first load just records who is live, so channels that were already on when
// you opened the app do not all pop up at once.
function detectOnline(favs) {
  var newly = [];
  favs.forEach(function (slug) {
    var c = state.channels[slug];
    if (!c) return;
    if (state.baselineSet && c.live && state.wasLive[slug] === false) newly.push(c.name);
    state.wasLive[slug] = c.live;
  });
  state.baselineSet = true;
  if (newly.length) notifyOnline(newly);
}
function notifyOnline(names) {
  var text = names.length === 1 ? names[0] + ' is online' : names.join(', ') + ' online';
  var el = document.getElementById('notify');
  el.innerHTML = '<span class="ndot"></span>';
  el.appendChild(document.createTextNode(text));
  el.className = 'show';
  clearTimeout(state.notifyTimer);
  state.notifyTimer = setTimeout(function () { el.className = ''; }, 6000);
}
function fmtViewers(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return String(n);
}
// The little pushpin. It is filled with currentColor so the CSS decides whether
// it looks green (pinned) or grey (the button you see on hover).
function pinIcon() {
  return '<svg class="pinicon" viewBox="0 0 24 24" fill="currentColor">' +
         '<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H19v-2l-3-2z"/></svg>';
}
function liveCount() {
  var n = 0;
  state.order.forEach(function (s) { if (state.channels[s].live) n++; });
  return n;
}
function firstLive() {
  for (var i = 0; i < state.order.length; i++) {
    if (state.channels[state.order[i]].live) return state.order[i];
  }
  return null;
}

/* Playback */
function showState(mode) {
  var idle = document.getElementById('idle');
  if (!mode || mode === 'hidden') { idle.className = 'hidden'; return; }
  idle.className = mode;                 // splash | offline | available | empty | lost
  if (mode === 'splash') return;         // the splash just shows the KICK TV wordmark
  var big, sub;
  if (mode === 'empty') { big = 'No channels yet'; sub = 'Open the menu to add one'; }
  else if (mode === 'lost') { big = "Can't reach Kick"; sub = 'Trying to reconnect'; }
  else if (mode === 'available') { big = 'Some channels are live'; sub = 'Open the menu to watch'; }
  else { big = 'No one is live right now'; sub = 'Open the menu to see your channels'; }
  var msg = document.getElementById('idle-msg');
  msg.innerHTML = '';
  var b = document.createElement('div'); b.className = 'idle-big'; b.textContent = big;
  var s = document.createElement('div'); s.className = 'idle-sub'; s.textContent = sub;
  msg.appendChild(b); msg.appendChild(s);
}
// Pick the right "nothing is playing" screen for where things stand.
function idleModeForNothing() {
  if (state.netDown) return 'lost';
  if (!getFavorites().length) return 'empty';
  if (firstLive()) return 'available';
  return 'offline';
}
// Show the correct idle screen. On a brand new setup with no channels, open the
// menu straight away so the Add row is right there.
function showNothing() {
  var m = idleModeForNothing();
  showState(m);
  if (m === 'empty' && state.ready) openSidebar();
}
function setBanner(msg) {
  var el = document.getElementById('pbstatus');
  if (!el) return;
  if (!msg) { el.className = 'hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className = '';
}
function teardownVideo() {
  PB.active = false;
  stopWatchdog();
  if (PB.reconnectTimer) { clearTimeout(PB.reconnectTimer); PB.reconnectTimer = null; }
  var video = document.getElementById('video');
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
}
function returnToIdle() {
  teardownVideo();
  state.current = null;
  state.tempChannel = null;
  PB.slug = null;
  setBanner('');
  updateGear();
  disconnectChat();
  showNothing();
}
function play(slug) {
  if (!slug) return;
  teardownVideo();
  disconnectChat();          // drop the old channel's chat; the new one connects once it loads
  setMode('player');
  state.current = slug;
  // if it is not one of your channels, it shows in the sidebar as a temporary row
  state.tempChannel = (getFavorites().indexOf(slug) === -1) ? slug : null;
  PB.slug = slug; PB.reloading = false; PB.netRetries = 0; PB.mediaRetries = 0;
  setBanner('');
  showState('hidden');
  updateGear();
  loadChannel(slug, false);
}
// Fetch the channel again, which also hands us a fresh playback link since the
// old one expires after a while, then start the video.
function loadChannel(slug, isRecovery) {
  apiGet(slug, function (err, raw) {
    if (state.current !== slug) return;              // they already switched away
    PB.reloading = false;
    if (err) {
      if (isRecovery) { scheduleReconnect(slug); return; }  // a recovery try failed, so keep trying
      toast('Kick API unreachable');
      returnToIdle();
      return;
    }
    var c = normalize(slug, raw);
    state.channels[slug] = c;
    if (!c.live || !c.playbackUrl) {
      // Stream ended or the channel is offline. Hop to the next live favorite
      // if auto-advance is on, otherwise fall back to the idle screen.
      if (settings.autoadvance) {
        var nx = nextLiveAfter(slug);
        if (nx) { toast('Auto-advancing to ' + (state.channels[nx].name || nx)); play(nx); return; }
      }
      toast(c.name + ' is offline');
      returnToIdle();
      return;
    }
    saveLast(slug);
    if (isRecovery) setBanner('');
    else { showOverlay(c); if (state.sidebarOpen) renderSidebar(slug); }
    attachStream(slug, c.playbackUrl);
    syncChat();                                  // connect chat for this channel if it is enabled
  });
}
function attachStream(slug, url) {
  var video = document.getElementById('video');
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  PB.netRetries = 0; PB.mediaRetries = 0;
  if (window.Hls && Hls.isSupported()) {
    var hls = new Hls(hlsConfig());
    state.hls = hls;
    hls.on(Hls.Events.ERROR, function (ev, data) {
      if (state.hls !== hls || !data || !data.fatal) return;   // old stream, or not fatal, so ignore
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) onNetworkError(slug, hls);
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) onMediaError(slug, hls);
      else recoverPlayback(slug);                              // nothing we can patch, reload it all
    });
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      if (state.hls !== hls) return;                           // a newer stream took over
      applyQualityPref();                                      // honour the saved quality choice
    });
    try { hls.loadSource(url); hls.attachMedia(video); }
    catch (e) { recoverPlayback(slug); return; }
  } else {
    try { video.src = url; } catch (e) { recoverPlayback(slug); return; } // let the TV play it itself
  }
  PB.active = true;
  playVideo(video);
  startWatchdog(slug);
}
function playVideo(video) {
  try {
    var p = video.play();
    if (p && p.catch) p.catch(function () {});   // play() may be blocked or interrupted, watchdog covers it
  } catch (e) {}
}
// While the browse popup is up, stop decoding/loading the stream so the popup
// stays smooth, then pick playback back up when it closes.
function pausePlaybackForBrowse() {
  var v = document.getElementById('video');
  try { v.pause(); } catch (e) {}
  if (state.hls) { try { state.hls.stopLoad(); } catch (e) {} }
  stopWatchdog();
}
function resumePlaybackAfterBrowse() {
  if (!state.current) return;
  if (state.hls) { try { state.hls.startLoad(); } catch (e) {} }
  playVideo(document.getElementById('video'));
  startWatchdog(state.current);
}
function onNetworkError(slug, hls) {
  if (state.current !== slug) return;
  PB.netRetries++;
  if (PB.netRetries <= MAX_NET_RETRY) {
    setBanner('Reconnecting…');
    try { hls.startLoad(); } catch (e) { recoverPlayback(slug); }
  } else {
    recoverPlayback(slug);                        // retried enough, the link probably expired, get a new one
  }
}
function onMediaError(slug, hls) {
  if (state.current !== slug) return;
  PB.mediaRetries++;
  if (PB.mediaRetries <= MAX_MEDIA_RETRY) {
    setBanner('Recovering…');
    try { hls.recoverMediaError(); } catch (e) { recoverPlayback(slug); }
  } else {
    recoverPlayback(slug);
  }
}
// Last resort. Throw away the current stream and load the channel from scratch
// with a new playback link.
function recoverPlayback(slug) {
  if (state.current !== slug || PB.reloading) return;
  PB.reloading = true;
  setBanner('Reconnecting…');
  stopWatchdog();
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  loadChannel(slug, true);
}
function scheduleReconnect(slug) {
  setBanner('Reconnecting…');
  if (PB.reconnectTimer) return;
  PB.reconnectTimer = setTimeout(function () {
    PB.reconnectTimer = null;
    if (state.current === slug) recoverPlayback(slug);
  }, 5000);
}
// Keeps an eye on playback. A stream can freeze without ever throwing an error,
// so if the play position stops moving for a while we step in and reconnect.
function startWatchdog(slug) {
  stopWatchdog();
  PB.lastTime = -1; PB.stallCount = 0;
  PB.watchdog = setInterval(function () {
    if (state.current !== slug || !PB.active) { stopWatchdog(); return; }
    var video = document.getElementById('video');
    if (video.paused) { PB.stallCount = 0; return; }   // they paused it, so this is not a freeze
    var t = video.currentTime;
    if (PB.lastTime >= 0 && Math.abs(t - PB.lastTime) < 0.05) {
      if (++PB.stallCount >= STALL_TICKS) { PB.stallCount = 0; recoverPlayback(slug); }
    } else {
      PB.stallCount = 0;
      PB.netRetries = 0; PB.mediaRetries = 0;
      setBanner('');                                   // it is moving again, clear the message
    }
    PB.lastTime = t;
  }, WATCHDOG_MS);
}
function stopWatchdog() {
  if (PB.watchdog) { clearInterval(PB.watchdog); PB.watchdog = null; }
}
function switchTo(slug) {
  if (!slug) return;
  var c = state.channels[slug];
  if (c && !c.live) { toast(c.name + ' is offline'); return; }
  closeSidebar();
  if (slug !== state.current) play(slug);
}
function exitApp() { try { window.close(); } catch (e) {} }
function armOrExit() {
  if (state.quitArmed) { exitApp(); return; }
  state.quitArmed = true;
  toast('Press Back again to exit');
  clearTimeout(state.quitTimer);
  state.quitTimer = setTimeout(function () { state.quitArmed = false; }, 2500);
}

function startPlayerPoll() {
  stopPlayerPoll();
  state.playerTimer = setInterval(function () {
    fetchFavorites(function () {
      if (state.sidebarOpen) renderSidebar();
      if (!state.current) { if (state.ready) showNothing(); return; }
      var cur = state.channels[state.current];
      if (cur) {
        var ov = document.getElementById('overlay');
        if (ov.className.indexOf('hidden') === -1) fillOverlay(cur);
      }
    });
  }, PLAYER_REFRESH_MS);
}
function stopPlayerPoll() {
  if (state.playerTimer) { clearInterval(state.playerTimer); state.playerTimer = null; }
}

/* The info bar at the top */
var overlayTimer = null;
function fillOverlay(c) {
  document.getElementById('ov-name').textContent = c.name;
  document.getElementById('ov-viewers').textContent = c.live ? fmtViewers(c.viewers) + ' viewers' : 'Offline';
  document.getElementById('ov-title').textContent =
    (c.category ? c.category + ' · ' : '') + (c.title || '');
}
function showOverlay(c) {
  fillOverlay(c);
  var ov = document.getElementById('overlay');
  ov.style.left = state.sidebarOpen ? '470px' : '0';
  ov.style.width = state.sidebarOpen ? '1450px' : '1920px';
  ov.className = '';
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(function () { ov.className = 'hidden'; }, 4000);
}
function toggleOverlay() {
  var ov = document.getElementById('overlay');
  if (ov.className === 'hidden') { var c = state.channels[state.current]; if (c) showOverlay(c); }
  else { ov.className = 'hidden'; clearTimeout(overlayTimer); }
}

/* The channel sidebar */
// Try to hide the pointer when the sidebar goes away, whether that was from Back
// or from sitting idle, and bring it back on the next real remote move. This is
// best effort. On some webOS versions cursor:none hides the system pointer and
// on others it does not, since the TV draws that pointer on top of the app. The
// important rule just keeps anything else from overriding our setting.
function hideCursor() {
  document.documentElement.classList.add('hidecursor');
}
function showCursor() {
  document.documentElement.classList.remove('hidecursor');
}
// The settings gear sits at the bottom-right and is available whenever the
// sidebar is open, so show it exactly then.
function updateGear() {
  var g = document.getElementById('quality-gear');
  if (!g) return;
  if (state.sidebarOpen) g.classList.remove('hidden');
  else g.classList.add('hidden');
}
function openSidebar() {
  if (!state.ready || browse.open) return;
  showCursor();
  if (!state.sidebarOpen) {
    state.sidebarOpen = true;
    document.getElementById('sidebar').className = 'open';
    var prefer = (state.current && state.order.indexOf(state.current) !== -1)
      ? state.current : null;
    renderSidebar(prefer);
    if (state.current && state.channels[state.current]) showOverlay(state.channels[state.current]);
  }
  resetIdle();
  updateGear();
  // only refetch when the data is stale, so opening the list stays snappy
  if (Date.now() - state.lastFetch > 8000) {
    fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(); });
  }
}
function closeSidebar() {
  clearTimeout(state.idleTimer);
  if (!state.sidebarOpen) return;
  state.sidebarOpen = false;
  document.getElementById('sidebar').className = '';
  document.getElementById('overlay').className = 'hidden';
  clearTimeout(overlayTimer);
  updateGear();
}
// If nothing happens for a few seconds, close the sidebar. Any action restarts the timer.
function resetIdle() {
  clearTimeout(state.idleTimer);
  if (!state.sidebarOpen) return;
  if (!getFavorites().length) return;   // onboarding: keep the menu up until they add a channel
  state.idleTimer = setTimeout(function () {
    if (state.mode === 'player') { closeSidebar(); hideCursor(); }
  }, IDLE_MS);
}
// Called when the pointer moves or Left is pressed. Open the sidebar and keep it up.
function nudgeSidebar() {
  if (!state.ready || state.mode !== 'player' || browse.open) return;
  if (!state.sidebarOpen) openSidebar(); else resetIdle();
}
function focusKeyOf(item) { return item ? (item.type === 'add' ? 'add' : item.slug) : null; }
function moveSide(delta) {
  if (!state.sideItems.length) return;
  var next = state.sideFocus + delta;
  if (next < 0 || next >= state.sideItems.length) return;
  state.sideFocus = next;
  applySideFocus();
}
function applySideFocus() {
  var list = document.getElementById('fav-list');
  for (var i = 0; i < list.children.length; i++) {
    var row = list.children[i];
    row.className = row.getAttribute('data-base') + (i === state.sideFocus ? ' focused' : '');
    if (i === state.sideFocus) {
      var top = row.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top - 8;
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = top + row.offsetHeight - list.clientHeight + 8;
    }
  }
}
function renderSidebar(focusKey) {
  var prevKey = (typeof focusKey !== 'undefined' && focusKey !== null)
    ? focusKey : focusKeyOf(state.sideItems[state.sideFocus]);

  state.sideItems = [];
  if (state.tempChannel && state.order.indexOf(state.tempChannel) === -1 && state.channels[state.tempChannel]) {
    state.sideItems.push({ type: 'temp', slug: state.tempChannel });
  }
  state.order.forEach(function (s) { state.sideItems.push({ type: 'chan', slug: s }); });
  state.sideItems.push({ type: 'add' });

  var cc = document.getElementById('side-count');
  if (state.netDown) { cc.textContent = 'Connection lost'; cc.className = 'neterr'; }
  else {
    cc.className = '';
    cc.textContent = state.order.length ? (liveCount() + ' / ' + state.order.length + ' live') : '';
  }

  var list = document.getElementById('fav-list');
  list.innerHTML = '';
  state.sideItems.forEach(function (item) {
    if (item.type === 'add') {
      var arow = document.createElement('div');
      arow.setAttribute('data-base', 'favrow addrow');
      arow.setAttribute('data-type', 'add');
      arow.className = 'favrow addrow';
      arow.innerHTML = '<span class="addplus">+</span><span class="addtext">Add channel</span>';
      list.appendChild(arow);
      return;
    }
    var isTemp = item.type === 'temp';
    var slug = item.slug, c = state.channels[slug], pinned = !isTemp && isPinned(slug);
    var base = 'favrow' + (isTemp ? ' temp' : '') + (c.live ? '' : ' offline') +
               (slug === state.current ? ' current' : '') + (pinned ? ' pinned' : '');
    var row = document.createElement('div');
    row.setAttribute('data-base', base);
    row.setAttribute('data-slug', slug);
    row.className = base;

    var av = document.createElement('div');
    av.className = 'favav' + (c.live ? '' : ' off');
    if (c.avatar) av.style.backgroundImage = 'url(' + c.avatar + ')';
    else av.textContent = (c.name || slug).charAt(0).toUpperCase();
    row.appendChild(av);

    var mid = document.createElement('div');
    mid.className = 'favmid';
    mid.innerHTML = '<div class="favname"></div><div class="favgame"></div>';
    mid.children[0].textContent = c.name;
    mid.children[1].textContent = c.live ? (c.category || 'Live') : 'Offline';
    row.appendChild(mid);

    var info = document.createElement('div');
    info.className = 'favinfo';
    var infoHtml = '';
    if (pinned) infoHtml += '<span class="pinmark">' + pinIcon() + '</span>';
    if (c.live) infoHtml += '<span class="livedot"></span><span class="favview">' + fmtViewers(c.viewers) + '</span>';
    info.innerHTML = infoHtml;
    row.appendChild(info);

    var act = document.createElement('div');
    act.className = 'favactions';
    if (isTemp) {
      act.innerHTML = '<span class="actbtn addbtn" data-act="addfav" title="Add to your channels">+</span>';
    } else {
      act.innerHTML =
        '<span class="actbtn pinbtn' + (pinned ? ' on' : '') + '" data-act="pin">' + pinIcon() + '</span>' +
        '<span class="actbtn rmbtn" data-act="remove">✕</span>';
    }
    row.appendChild(act);

    list.appendChild(row);
  });

  var idx = -1;
  for (var i = 0; i < state.sideItems.length; i++) {
    if (focusKeyOf(state.sideItems[i]) === prevKey) { idx = i; break; }
  }
  state.sideFocus = idx === -1 ? 0 : idx;
  applySideFocus();

  // Show the plus in the header only when the list is long enough to scroll,
  // because then the Add row down at the bottom is out of sight.
  var addBtn = document.getElementById('side-add');
  if (addBtn) addBtn.className = (list.scrollHeight > list.clientHeight + 2) ? '' : 'hidden';
  // Nothing to refresh when there are no channels, so hide that button.
  var refBtn = document.getElementById('side-refresh');
  if (refBtn) { if (state.order.length) refBtn.classList.remove('hidden'); else refBtn.classList.add('hidden'); }
}
function activateSide() {
  var item = state.sideItems[state.sideFocus];
  if (!item) return;
  if (item.type === 'add') openAdd(); else switchTo(item.slug);
}
var pendingAction = null;
function askRemove(slug) {
  if (!slug || !state.channels[slug]) return;
  pendingAction = { type: 'remove', slug: slug };
  document.getElementById('confirm-text').textContent =
    'Remove ' + state.channels[slug].name + ' from favorites?';
  document.getElementById('confirm-yes').textContent = 'Remove';
  setMode('confirm');
}
function confirmYes() {
  var a = pendingAction; pendingAction = null;
  setMode('player');
  if (!a) return;
  if (a.type === 'remove' && state.channels[a.slug]) {
    var name = state.channels[a.slug].name;
    removeFavorite(a.slug);
    toast('Removed ' + name);
    fetchFavorites(function () {
      if (state.sidebarOpen) renderSidebar();
      if (!state.current) showNothing();
    });
  }
}
function confirmNo() {
  pendingAction = null;
  setMode('player');
  if (state.sidebarOpen) renderSidebar();
  if (!state.current) showNothing();
}
function togglePinFocused() {
  var item = state.sideItems[state.sideFocus];
  if (!item || item.type !== 'chan') return;
  var nowPinned = togglePin(item.slug);
  toast((nowPinned ? 'Pinned ' : 'Unpinned ') + state.channels[item.slug].name);
  fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(item.slug); });
}
// The temporary (browsed) channel row has an add icon that saves it for good.
function addTempToFavorites() {
  var slug = state.tempChannel;
  if (!slug) return;
  addFavorite(slug);
  state.tempChannel = null;
  toast('Added ' + (state.channels[slug] ? state.channels[slug].name : slug));
  fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(slug); });
}
function refreshSide() {
  var btn = document.getElementById('side-refresh');
  btn.className = 'spinning';
  var done = false, minned = false;
  function stop() { if (done && minned) btn.className = ''; }
  setTimeout(function () { minned = true; stop(); }, 700); // keep it spinning for at least one full turn
  fetchFavorites(function () {
    if (state.sidebarOpen) renderSidebar(); else openSidebar(); // pop the list open once the refresh finishes
    if (!state.current) showState(idleModeForNothing());
    done = true; stop();
  });
}

/* Add channel dialog */
function openAdd() {
  setMode('add');
  document.getElementById('addmodal').className = '';
  var input = document.getElementById('addinput');
  input.value = '';
  setTimeout(function () { input.focus(); }, 50);
}
function closeAdd() {
  document.getElementById('addmodal').className = 'hidden';
  document.getElementById('addinput').blur();
  setMode('player');
  if (state.sidebarOpen) renderSidebar('add'); else openSidebar();
  if (!state.current) showNothing();   // bring back the idle message we hid
}
function confirmAdd() {
  var slug = document.getElementById('addinput').value.trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?kick\.com\//, '').replace(/[\/?#].*$/, '');
  if (!slug) { closeAdd(); return; }
  toast('Checking ' + slug + '…');
  apiGet(slug, function (err, raw) {
    if (err) { toast(err === 404 ? 'No channel named "' + slug + '"' : 'Kick API unreachable'); return; }
    state.channels[slug] = normalize(slug, raw);
    addFavorite(slug);
    document.getElementById('addmodal').className = 'hidden';
    document.getElementById('addinput').blur();
    setMode('player');
    toast('Added ' + state.channels[slug].name);
    fetchFavorites(function () {
      if (!state.sidebarOpen) openSidebar(); else renderSidebar(slug);
      if (!state.current) showState(idleModeForNothing());
    });
  });
}

/* Browse live streams (blue button) */
// Kick's directory has no language filter, so we pull the top live streams
// (sorted by viewers) and filter by language here on the TV.
var BROWSE_LANGS = [
  { label: 'All',      value: 'all' },
  { label: 'English',  value: 'English' },
  { label: 'Turkce',   value: 'Turkish' },
  { label: 'Espanol',  value: 'Spanish' },
  { label: 'Portugues',value: 'Portuguese' },
  { label: 'Arabic',   value: 'Arabic' },
  { label: 'Francais', value: 'French' },
  { label: 'Deutsch',  value: 'German' },
  { label: 'Polski',   value: 'Polish' },
  { label: 'Russian',  value: 'Russian' }
];
var BROWSE_COLS = 4;
var browse = { open: false, lang: 'all', langIdx: 0, zone: 'grid', gridIdx: 0,
               raw: [], streams: [], page: 1, hasMore: true, fetching: false };

function loadBrowseLangPref() {
  var v = null;
  try { v = localStorage.getItem('kicktv.browselang'); } catch (e) {}
  browse.lang = v || 'all';
  browse.langIdx = 0;
  for (var i = 0; i < BROWSE_LANGS.length; i++) {
    if (BROWSE_LANGS[i].value === browse.lang) { browse.langIdx = i; break; }
  }
}
function saveBrowseLangPref() { try { localStorage.setItem('kicktv.browselang', browse.lang); } catch (e) {} }
function setBrowseStatus(msg) { document.getElementById('browse-status').textContent = msg || ''; }
function thumbUrl(s) {
  var t = s && s.thumbnail;
  if (!t) return null;
  return t.src || t.url || (typeof t === 'string' ? t : null);
}
function openBrowse() {
  if (!state.ready) return;
  browse.open = true;
  showCursor();
  closeSidebar();
  pausePlaybackForBrowse();
  document.getElementById('browse').className = '';
  loadBrowseLangPref();
  renderBrowseLangs();
  browse.zone = 'grid'; browse.gridIdx = 0;
  browse.raw = []; browse.page = 1; browse.hasMore = true; browse.fetching = false;
  document.getElementById('browse-grid').innerHTML = '';
  loadBrowseMore(true);
}
function closeBrowse() {
  browse.open = false;
  document.getElementById('browse').className = 'hidden';
  resumePlaybackAfterBrowse();
}
// Fetch one page of the live directory and append it. `initial` chains a few
// pages on open to fill the grid; scrolling to the bottom pulls more.
function loadBrowseMore(initial) {
  if (browse.fetching || !browse.hasMore || browse.page > 8) return;
  browse.fetching = true;
  if (!browse.raw.length) setBrowseStatus('Loading...');
  var pg = browse.page;
  serviceGet('/stream/livestreams/en?page=' + pg + '&limit=50&sort=desc', function (err, data) {
    browse.fetching = false;
    if (!browse.open) return;
    var arr = (!err && data && data.data) ? data.data : [];
    if (!arr.length) {
      browse.hasMore = false;
      if (!browse.raw.length) setBrowseStatus('Could not reach Kick'); else renderBrowse();
      return;
    }
    browse.raw = browse.raw.concat(arr);
    browse.page = pg + 1;
    renderBrowse();
    if (initial && browse.page <= 3) loadBrowseMore(true);
  });
}
function renderBrowseLangs() {
  var box = document.getElementById('browse-langs');
  box.innerHTML = '';
  BROWSE_LANGS.forEach(function (l, i) {
    var chip = document.createElement('span');
    chip.className = 'blang';
    chip.setAttribute('data-idx', i);
    chip.textContent = l.label;
    box.appendChild(chip);
  });
}
function renderBrowse() {
  var list = (browse.raw || []).slice();
  if (browse.lang !== 'all') list = list.filter(function (s) { return s.language === browse.lang; });
  list.sort(function (a, b) { return (b.viewer_count || 0) - (a.viewer_count || 0); });
  browse.streams = list;

  var grid = document.getElementById('browse-grid');
  var savedScroll = grid.scrollTop;
  grid.innerHTML = '';
  browse.streams.forEach(function (s, i) {
    var ch = s.channel || {}, user = ch.user || {};
    var card = document.createElement('div');
    card.className = 'bcard';
    card.setAttribute('data-idx', i);
    var url = thumbUrl(s);
    var thumb = document.createElement('div');
    thumb.className = 'bthumb';
    if (url) thumb.style.backgroundImage = 'url(' + url + ')';
    var v = document.createElement('span');
    v.className = 'bviewers';
    v.innerHTML = '<span class="bdot"></span>';
    v.appendChild(document.createTextNode(fmtViewers(s.viewer_count || 0)));
    thumb.appendChild(v);
    var already = getFavorites().indexOf(ch.slug) !== -1;
    var add = document.createElement('span');
    add.className = 'baddbtn' + (already ? ' added' : '');
    add.setAttribute('data-act', 'badd');
    add.setAttribute('data-slug', ch.slug || s.slug);
    add.textContent = already ? '✓' : '+';
    card.appendChild(thumb);
    var meta = document.createElement('div');
    meta.className = 'bmeta';
    meta.innerHTML = '<div class="bname"></div><div class="btitle"></div><div class="bsub"></div>';
    meta.children[0].textContent = user.username || ch.slug || s.slug;
    meta.children[1].textContent = s.session_title || '';
    meta.children[2].textContent =
      ((s.categories && s.categories[0] && s.categories[0].name) || '') +
      (s.language ? '  ·  ' + s.language : '');
    card.appendChild(meta);
    card.appendChild(add);
    grid.appendChild(card);
  });
  grid.scrollTop = savedScroll;   // keep position while more pages append

  if (!browse.streams.length) {
    setBrowseStatus(browse.fetching ? 'Loading...' :
      (browse.lang === 'all' ? 'Nothing live right now' : 'No live channels in this language yet'));
  } else setBrowseStatus('');

  if (browse.gridIdx >= browse.streams.length) browse.gridIdx = Math.max(0, browse.streams.length - 1);
  applyBrowseFocus();
}
function applyBrowseFocus() {
  var langsEl = document.getElementById('browse-langs');
  for (var i = 0; i < langsEl.children.length; i++) {
    var chip = langsEl.children[i];
    chip.className = 'blang' +
      (BROWSE_LANGS[i].value === browse.lang ? ' sel' : '') +
      (browse.zone === 'lang' && i === browse.langIdx ? ' focused' : '');
  }
  var grid = document.getElementById('browse-grid');
  for (var j = 0; j < grid.children.length; j++) {
    grid.children[j].className = 'bcard' + (browse.zone === 'grid' && j === browse.gridIdx ? ' focused' : '');
  }
  if (browse.zone === 'grid' && grid.children[browse.gridIdx]) {
    var el = grid.children[browse.gridIdx];
    var top = el.offsetTop - grid.offsetTop;
    if (top < grid.scrollTop) grid.scrollTop = top - 12;
    else if (top + el.offsetHeight > grid.scrollTop + grid.clientHeight)
      grid.scrollTop = top + el.offsetHeight - grid.clientHeight + 12;
  }
}
function selectBrowseLang(idx) {
  browse.langIdx = idx;
  browse.lang = BROWSE_LANGS[idx].value;
  saveBrowseLangPref();
  browse.gridIdx = 0;
  renderBrowse();            // just re-filter what we already fetched
}
function browseMove(dx, dy) {
  if (browse.zone === 'lang') {
    if (dy === 1) { browse.zone = 'grid'; browse.gridIdx = 0; applyBrowseFocus(); return; }
    if (dx !== 0) {
      var n = browse.langIdx + dx;
      if (n >= 0 && n < BROWSE_LANGS.length) selectBrowseLang(n);
    }
    return;
  }
  var count = browse.streams.length;
  if (dy === -1 && browse.gridIdx < BROWSE_COLS) { browse.zone = 'lang'; applyBrowseFocus(); return; }
  if (!count) return;
  var idx = browse.gridIdx;
  if (dx === 1 && idx < count - 1) idx++;
  else if (dx === -1 && idx > 0) idx--;
  else if (dy === 1 && idx + BROWSE_COLS < count) idx += BROWSE_COLS;
  else if (dy === -1 && idx - BROWSE_COLS >= 0) idx -= BROWSE_COLS;
  else if (dy === 1 || dx === 1) loadBrowseMore(false);
  browse.gridIdx = idx;
  applyBrowseFocus();
  // pull the next page as soon as focus reaches the last couple of rows
  if (browse.gridIdx >= browse.streams.length - 2 * BROWSE_COLS) loadBrowseMore(false);
}
function browseActivate() {
  if (browse.zone === 'lang') { browse.zone = 'grid'; browse.gridIdx = 0; applyBrowseFocus(); return; }
  var s = browse.streams[browse.gridIdx];
  if (s && s.channel && s.channel.slug) {
    browse.open = false;
    document.getElementById('browse').className = 'hidden';
    play(s.channel.slug);   // starts fresh, so no need to resume the paused stream
  }
}
// The "+" on a browse card saves that streamer without leaving the popup.
function browseAddFavorite(slug) {
  if (!slug || getFavorites().indexOf(slug) !== -1) return;
  addFavorite(slug);
  if (slug === state.tempChannel) state.tempChannel = null;   // it is a real favorite now
  state.lastFetch = 0;                                        // let the sidebar refresh next time
  apiGet(slug, function (err, raw) { if (!err) state.channels[slug] = normalize(slug, raw); });
  toast('Added ' + slug);
  renderBrowse();          // flip the card's + into a check
}

/* Quality preference (used by the Settings menu below) */
var quality = { sel: 'auto' };
function loadQualityPref() {
  var v = null;
  try { v = localStorage.getItem('kicktv.quality'); } catch (e) {}
  if (v === null || v === 'auto') { quality.sel = 'auto'; return; }
  var n = parseInt(v, 10);
  quality.sel = isNaN(n) ? 'auto' : n;
}
function saveQualityPref() {
  try { localStorage.setItem('kicktv.quality', quality.sel === 'auto' ? 'auto' : String(quality.sel)); } catch (e) {}
}
// The saved preference is a target height (or 'auto'). Turn it into a level index
// for whatever stream is playing now: the matching height, or the closest one at
// or below it, or failing that the highest the stream offers.
function levelIndexForPref() {
  if (quality.sel === 'auto' || !state.hls || !state.hls.levels || !state.hls.levels.length) return -1;
  var levels = state.hls.levels, best = -1, bestH = -1, maxIdx = 0, maxH = -1;
  for (var i = 0; i < levels.length; i++) {
    var h = levels[i].height || 0;
    if (h > maxH) { maxH = h; maxIdx = i; }
    if (h <= quality.sel && h > bestH) { bestH = h; best = i; }
  }
  return best !== -1 ? best : maxIdx;
}
function applyQualityPref() {
  if (!state.hls) return;
  try { state.hls.currentLevel = levelIndexForPref(); } catch (e) {}
}
// Build the quality rows: Auto on top, then the stream's levels high to low.
function qualityRows() {
  var rows = [{ label: 'Auto', auto: true, h: -1, idx: -1 }];
  if (state.hls && state.hls.levels && state.hls.levels.length) {
    var lv = [];
    state.hls.levels.forEach(function (l, i) {
      var fps = (l.attrs && l.attrs['FRAME-RATE']) ? Math.round(parseFloat(l.attrs['FRAME-RATE'])) : 0;
      var label = l.height ? (l.height + 'p') : (Math.round((l.bitrate || 0) / 1000) + 'k');
      if (fps >= 50) label += String(fps);
      lv.push({ label: label, auto: false, h: l.height || 0, idx: i });
    });
    lv.sort(function (a, b) { return b.h - a.h; });
    rows = rows.concat(lv);
  }
  return rows;
}
function qualityIsSel(row) {
  return row.auto ? quality.sel === 'auto' : (quality.sel !== 'auto' && row.h === quality.sel);
}
function pickQuality(row) {
  if (row.auto) {
    quality.sel = 'auto';
    if (state.hls) { try { state.hls.currentLevel = -1; } catch (e) {} }   // -1 hands control back to auto
  } else {
    quality.sel = row.h;
    if (state.hls && row.idx >= 0) { try { state.hls.currentLevel = row.idx; } catch (e) {} }
  }
  saveQualityPref();
}

/* Player options that ride on top of hls.js */
// Low latency trims how far behind the live edge we play. It only takes hold on
// a fresh hls instance, so toggling it reloads the current stream.
function hlsConfig() {
  var cfg = {
    enableWorker: true, capLevelToPlayerSize: true,
    manifestLoadingMaxRetry: 4, manifestLoadingRetryDelay: 1000,
    levelLoadingMaxRetry: 4, levelLoadingRetryDelay: 1000,
    fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000
  };
  if (settings.lowlatency) {
    cfg.lowLatencyMode = true;
    cfg.liveSyncDurationCount = 2;
    cfg.maxLiveSyncPlaybackRate = 1.5;
    cfg.maxBufferLength = 10;
    cfg.backBufferLength = 0;
  } else {
    cfg.maxBufferLength = 30;
  }
  return cfg;
}
// The next live favorite after `slug`, used by auto-advance when a stream ends.
function nextLiveAfter(slug) {
  for (var i = 0; i < state.order.length; i++) {
    var s = state.order[i];
    if (s !== slug && state.channels[s] && state.channels[s].live) return s;
  }
  return null;
}

/* Settings menu (opened by the gear, or the Yellow button, while the list is open) */
var settings = { open: false, focus: 0, items: [],
                 chat: false, lowlatency: false, autoadvance: false };
function loadSettings() {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('kicktv.settings')) || {}; } catch (e) {}
  settings.chat = !!s.chat;
  settings.lowlatency = !!s.lowlatency;
  settings.autoadvance = !!s.autoadvance;
}
function saveSettings() {
  try {
    localStorage.setItem('kicktv.settings', JSON.stringify({
      chat: settings.chat, lowlatency: settings.lowlatency, autoadvance: settings.autoadvance
    }));
  } catch (e) {}
}
// The rows: three toggles, a Quality header, then the stream's quality rungs.
function settingsBuild() {
  var items = [
    { kind: 'toggle', key: 'chat', label: 'Live chat' },
    { kind: 'toggle', key: 'lowlatency', label: 'Low latency' },
    { kind: 'toggle', key: 'autoadvance', label: 'Auto-advance' },
    { kind: 'header', label: 'Quality' }
  ];
  qualityRows().forEach(function (r) {
    items.push({ kind: 'quality', label: r.label, auto: r.auto, h: r.h, idx: r.idx });
  });
  return items;
}
function firstFocusableSetting() {
  for (var i = 0; i < settings.items.length; i++) if (settings.items[i].kind !== 'header') return i;
  return 0;
}
function openSettings() {
  if (!state.ready || settings.open) return;
  settings.open = true;
  setMode('settings');
  settings.items = settingsBuild();
  settings.focus = firstFocusableSetting();
  document.getElementById('settingsmodal').className = '';
  renderSettings();
}
function closeSettings() {
  settings.open = false;
  document.getElementById('settingsmodal').className = 'hidden';
  setMode('player');
  if (state.sidebarOpen) resetIdle();
}
function renderSettings() {
  var list = document.getElementById('settings-list');
  list.innerHTML = '';
  var qmarked = false;
  settings.items.forEach(function (it, i) {
    var el = document.createElement('div');
    el.setAttribute('data-idx', i);
    if (it.kind === 'header') {
      el.className = 'shead';
      el.textContent = it.label;
      list.appendChild(el);
      return;
    }
    if (it.kind === 'toggle') {
      var on = !!settings[it.key];
      el.setAttribute('data-focusable', '1');
      var lab = document.createElement('span'); lab.className = 'slabel'; lab.textContent = it.label;
      var pill = document.createElement('span'); pill.className = 'spill' + (on ? ' on' : ''); pill.textContent = on ? 'On' : 'Off';
      el.appendChild(lab); el.appendChild(pill);
    } else { // quality
      var sel = !qmarked && qualityIsSel(it);
      if (sel) qmarked = true;
      el.setAttribute('data-focusable', '1');
      el.setAttribute('data-sel', sel ? '1' : '0');
      var qlab = document.createElement('span'); qlab.className = 'slabel qopt'; qlab.textContent = it.label;
      var chk = document.createElement('span'); chk.className = 'scheck'; chk.textContent = sel ? '✓' : '';
      el.appendChild(qlab); el.appendChild(chk);
    }
    list.appendChild(el);
  });
  applySettingsFocus();
}
function applySettingsFocus() {
  var list = document.getElementById('settings-list');
  for (var i = 0; i < list.children.length; i++) {
    var el = list.children[i], it = settings.items[i];
    if (!it || it.kind === 'header') continue;
    var cls = it.kind === 'toggle' ? 'srow' : ('srow' + (el.getAttribute('data-sel') === '1' ? ' sel' : ''));
    el.className = cls + (i === settings.focus ? ' focused' : '');
    if (i === settings.focus) {
      var top = el.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top - 6;
      else if (top + el.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = top + el.offsetHeight - list.clientHeight + 6;
    }
  }
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
function settingsActivate() {
  var it = settings.items[settings.focus];
  if (!it) return;
  if (it.kind === 'toggle') {
    settings[it.key] = !settings[it.key];
    saveSettings();
    applyToggle(it.key);
    renderSettings();
  } else if (it.kind === 'quality') {
    pickQuality(it);
    toast('Quality: ' + it.label);
    renderSettings();
  }
}
// Make a toggle take effect right away.
function applyToggle(key) {
  if (key === 'chat') {
    syncChat();
    toast('Live chat ' + (settings.chat ? 'on' : 'off'));
  } else if (key === 'lowlatency') {
    toast('Low latency ' + (settings.lowlatency ? 'on' : 'off'));
    if (state.current) recoverPlayback(state.current);   // reload so the new buffering takes hold
  } else if (key === 'autoadvance') {
    toast('Auto-advance ' + (settings.autoadvance ? 'on' : 'off'));
  }
}

/* Read-only live chat overlay.
   Kick's chat is delivered over a public Pusher WebSocket, so we can read it
   without any login. We connect straight to Pusher (no Cloudflare in the way,
   unlike the API), subscribe to the channel's chatroom, and print messages.
   Sending would need an account, which this app deliberately does not do. */
var CHAT_KEY = '32cbd69e4b950bf97679';   // Kick's public Pusher app key (us2)
var CHAT_URL = 'wss://ws-us2.pusher.com/app/' + CHAT_KEY + '?protocol=7&client=js&version=8.4.0&flash=false';
var CHAT_MAX = 80;                        // keep at most this many messages on screen
var chat = { ws: null, room: null, want: false, retry: 0, retryTimer: null };
function chatEl() { return document.getElementById('chat'); }
function showChatOverlay() { chatEl().className = 'on'; }
function hideChatOverlay() { chatEl().className = ''; }
function clearChat() { chatEl().innerHTML = ''; }
function currentRoomId() {
  var c = state.current && state.channels[state.current];
  return (c && c.chatroomId) ? c.chatroomId : null;
}
// Bring chat into line with the current setting and channel.
function syncChat() {
  if (!settings.chat || !state.current) { disconnectChat(); return; }
  var room = currentRoomId();
  if (!room) { disconnectChat(); return; }
  if (chat.room === room && chat.ws && chat.ws.readyState <= 1) { showChatOverlay(); return; }
  connectChat(room);
}
function connectChat(room) {
  disconnectChat();
  chat.want = true; chat.room = room; chat.retry = 0;
  clearChat(); showChatOverlay();
  openChatSocket(room);
}
function openChatSocket(room) {
  var ws;
  try { ws = new WebSocket(CHAT_URL); } catch (e) { return; }
  chat.ws = ws;
  ws.onmessage = function (ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.event === 'pusher:ping') { try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch (e) {} return; }
    if (m.event === 'pusher:connection_established') {
      try { ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'chatrooms.' + room + '.v2' } })); } catch (e) {}
      return;
    }
    if (m.event && m.event.indexOf('ChatMessageEvent') !== -1) {
      var d; try { d = JSON.parse(m.data); } catch (e) { return; }
      addChatMessage(d);
    }
  };
  ws.onclose = function () {
    if (chat.ws !== ws) return;
    chat.ws = null;
    if (chat.want && settings.chat && currentRoomId() === room) {
      chat.retry++;
      var delay = Math.min(15000, 1500 * chat.retry);
      chat.retryTimer = setTimeout(function () {
        if (chat.want && settings.chat && currentRoomId() === room) openChatSocket(room);
      }, delay);
    }
  };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}
function disconnectChat() {
  chat.want = false; chat.room = null;
  if (chat.retryTimer) { clearTimeout(chat.retryTimer); chat.retryTimer = null; }
  if (chat.ws) { try { chat.ws.onclose = null; chat.ws.close(); } catch (e) {} chat.ws = null; }
  hideChatOverlay(); clearChat();
}
// Kick puts emotes inline as [emote:12345:Name]. Render the real emote image so
// chat looks like Kick, not "KEKW" text. Built node by node (never innerHTML) so
// message text can never inject markup. If an image fails, fall back to its name.
function appendChatContent(row, content) {
  content = String(content || '');
  var re = /\[emote:(\d+):([^\]]+)\]/g, last = 0, m;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) row.appendChild(document.createTextNode(content.slice(last, m.index)));
    var img = document.createElement('img');
    img.className = 'cemote';
    img.src = 'https://files.kick.com/emotes/' + m[1] + '/fullsize';
    img.alt = m[2];
    (function (name) {
      img.onerror = function () {
        if (this.parentNode) this.parentNode.replaceChild(document.createTextNode(name), this);
      };
    })(m[2]);
    row.appendChild(img);
    last = re.lastIndex;
  }
  if (last < content.length) row.appendChild(document.createTextNode(content.slice(last)));
}
function addChatMessage(d) {
  if (!d || !d.sender) return;
  var box = chatEl();
  var row = document.createElement('div');
  row.className = 'cmsg';
  var u = document.createElement('span');
  u.className = 'cuser';
  var color = d.sender.identity && d.sender.identity.color;
  u.style.color = color || '#53fc18';
  u.textContent = d.sender.username || '';
  row.appendChild(u);
  row.appendChild(document.createTextNode(' '));
  appendChatContent(row, d.content);
  box.appendChild(row);
  while (box.children.length > CHAT_MAX) box.removeChild(box.firstChild);
}

/* OLED burn-in guard.
   Static bright pixels can burn into an OLED over time. When nothing has moved
   for a while and the screen is showing something static (an idle message or a
   paused frame), we heavily dim the whole panel so nothing stays lit and bright.
   Any remote or pointer activity wakes it back up. */
var SAVER_MS = 240000;      // four minutes of stillness on a static screen
var saver = { on: false, timer: null };
function markInput() {
  state.lastInput = Date.now();
  if (saver.on) wakeSaver();
}
function isStaticScreen() {
  var v = document.getElementById('video');
  return !state.current || (v && v.paused);   // idle message, or a frozen paused frame
}
function checkSaver() {
  if (!state.ready || saver.on) return;
  if (Date.now() - state.lastInput > SAVER_MS && isStaticScreen()) showSaver();
}
function showSaver() { saver.on = true; document.getElementById('saver').className = 'on'; }
function wakeSaver() { saver.on = false; document.getElementById('saver').className = ''; }

/* Small helpers */
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = '';
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(function () { t.className = 'hidden'; }, 2500);
}
function setMode(mode) {
  state.mode = mode;
  document.getElementById('addmodal').className = (mode === 'add') ? '' : 'hidden';
  document.getElementById('confirmmodal').className = (mode === 'confirm') ? '' : 'hidden';
  // hide the idle message behind a dialog so its text does not show through
  if (mode === 'add' || mode === 'confirm') document.getElementById('idle').className = 'hidden';
}

/* Remote and keyboard input */
document.addEventListener('keydown', function (e) {
  var k = e.keyCode;
  var wasSaver = saver.on;
  markInput();                                      // any key counts as activity for the burn-in guard
  if (wasSaver) { e.preventDefault(); return; }     // the first press just dismisses the screensaver
  if (!state.ready) { e.preventDefault(); return; } // still on the splash, ignore input until data is ready
  if (k !== KEY.BACK && k !== KEY.STOP) state.quitArmed = false; // anything but Back cancels a pending exit
  if (browse.open) {
    e.preventDefault();
    if (k === KEY.BLUE || k === KEY.BACK) closeBrowse();
    else if (k === KEY.LEFT) browseMove(-1, 0);
    else if (k === KEY.RIGHT) browseMove(1, 0);
    else if (k === KEY.UP) browseMove(0, -1);
    else if (k === KEY.DOWN) browseMove(0, 1);
    else if (k === KEY.OK) browseActivate();
    return;
  }
  if (settings.open) {
    e.preventDefault();
    if (k === KEY.BACK || k === KEY.YELLOW || k === KEY.LEFT) closeSettings();
    else if (k === KEY.UP) settingsMove(-1);
    else if (k === KEY.DOWN) settingsMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) settingsActivate();
    return;
  }
  if (state.mode === 'add') {
    if (k === KEY.BACK) { e.preventDefault(); closeAdd(); }
    else if (k === KEY.OK) { e.preventDefault(); confirmAdd(); }
    return; // let the on-screen keyboard do the typing
  }
  if (state.mode === 'confirm') {
    e.preventDefault();
    if (k === KEY.OK) confirmYes();
    else if (k === KEY.BACK) confirmNo();
    return;
  }
  // watching a stream
  e.preventDefault();
  var video = document.getElementById('video');
  if (k === KEY.BLUE) { openBrowse(); return; }        // blue opens the live browser
  if (state.sidebarOpen) {
    resetIdle();
    if (k === KEY.UP) moveSide(-1);
    else if (k === KEY.DOWN) moveSide(1);
    else if (k === KEY.OK) activateSide();               // OK (or a click) opens the highlighted channel
    else if (k === KEY.GREEN) refreshSide();             // green button refreshes the list
    else if (k === KEY.YELLOW) openSettings();           // yellow opens the settings menu
    else if (k === KEY.LEFT || k === KEY.RIGHT) closeSidebar(); // left or right tucks the list away
    else if (k === KEY.BACK) { closeSidebar(); hideCursor(); } // close the list and hide the pointer
    return;
  }
  if (k === KEY.BACK || k === KEY.STOP) { armOrExit(); return; }
  if (k === KEY.LEFT || k === KEY.RIGHT) openSidebar();  // left or right brings the list up
  else if (k === KEY.GREEN) refreshSide();              // green button refreshes even while watching
  else if (k === KEY.OK) { if (state.current) toggleOverlay(); else openSidebar(); }
  else if (k === KEY.PAUSE) { try { video.pause(); } catch (e2) {} }
  else if (k === KEY.PLAY) { playVideo(video); }
});

/* Pointer, both mouse and the magic remote */
function favRowFromEvent(e) {
  var el = e.target;
  while (el && el !== document.body &&
         !(el.getAttribute && (el.getAttribute('data-slug') || el.getAttribute('data-type')))) {
    el = el.parentNode;
  }
  if (!el || el === document.body) return null;
  var list = document.getElementById('fav-list');
  for (var i = 0; i < list.children.length; i++) {
    if (list.children[i] === el) return { row: el, idx: i };
  }
  return null;
}
function browseCardFromEvent(e) {
  var el = e.target;
  while (el && el !== document.body && !(el.getAttribute && el.getAttribute('data-idx'))) el = el.parentNode;
  if (!el || el === document.body) return null;
  var i = parseInt(el.getAttribute('data-idx'), 10);
  if (isNaN(i) || i < 0 || i >= browse.streams.length) return null;
  return { el: el, idx: i };
}
(function wirePointer() {
  var playerEl = document.getElementById('player');
  playerEl.addEventListener('click', function (e) {
    if (!state.ready || state.mode !== 'player') return;
    if (e.target.id === 'video' || e.target === playerEl || e.target.id === 'idle') {
      if (state.sidebarOpen) closeSidebar(); else openSidebar();
    }
  });
  // Moving the pointer opens the sidebar, which then hides itself after a few idle seconds.
  var lastX = -1, lastY = -1;
  playerEl.addEventListener('mousemove', function (e) {
    if (!state.ready || state.mode !== 'player') return;
    if (lastX >= 0 && Math.abs(e.clientX - lastX) < 6 && Math.abs(e.clientY - lastY) < 6) return;
    lastX = e.clientX; lastY = e.clientY;
    showCursor();      // a real move brings the pointer back and opens the sidebar
    nudgeSidebar();
  });
  document.getElementById('side-refresh').addEventListener('click', function (e) {
    e.stopPropagation();
    if (state.mode === 'player') refreshSide();
  });
  var favList = document.getElementById('fav-list');
  favList.addEventListener('mouseover', function (e) {
    resetIdle();
    var hit = favRowFromEvent(e);
    if (hit && hit.idx !== state.sideFocus) { state.sideFocus = hit.idx; applySideFocus(); }
  });
  favList.addEventListener('click', function (e) {
    var hit = favRowFromEvent(e);
    if (!hit) return;
    state.sideFocus = hit.idx; applySideFocus();
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    var slug = hit.row.getAttribute('data-slug');
    if (act === 'pin' && slug) { togglePinFocused(); }
    else if (act === 'remove' && slug) { askRemove(slug); }
    else if (act === 'addfav') { addTempToFavorites(); }
    else { activateSide(); }
  });
  favList.addEventListener('wheel', function (e) {
    if (!state.sidebarOpen) return;
    e.preventDefault();
    favList.scrollTop += (e.deltaY > 0 ? 1 : -1) * 88;
  });
  document.getElementById('addok').addEventListener('click', function () {
    if (state.mode === 'add') confirmAdd();
  });
  document.getElementById('addcancel').addEventListener('click', function () {
    if (state.mode === 'add') closeAdd();
  });
  document.getElementById('addmodal').addEventListener('click', function (e) {
    if (state.mode === 'add' && e.target === this) closeAdd();
  });
  document.getElementById('confirm-yes').addEventListener('click', function () {
    if (state.mode === 'confirm') confirmYes();
  });
  document.getElementById('confirm-no').addEventListener('click', function () {
    if (state.mode === 'confirm') confirmNo();
  });
  document.getElementById('confirmmodal').addEventListener('click', function (e) {
    if (state.mode === 'confirm' && e.target === this) confirmNo();
  });
  var addBtn = document.getElementById('side-add');
  if (addBtn) addBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (state.mode === 'player') openAdd();
  });
  // Browse popup pointer
  document.getElementById('browse-langs').addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-idx') !== null && el.getAttribute('data-idx') !== undefined)) el = el.parentNode;
    if (el && el !== this && el.getAttribute('data-idx') != null) {
      browse.zone = 'lang';
      selectBrowseLang(parseInt(el.getAttribute('data-idx'), 10));
      applyBrowseFocus();
    }
  });
  var browseGrid = document.getElementById('browse-grid');
  browseGrid.addEventListener('mouseover', function (e) {
    var c = browseCardFromEvent(e);
    if (c) { browse.zone = 'grid'; browse.gridIdx = c.idx; applyBrowseFocus(); }
  });
  browseGrid.addEventListener('click', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-act') === 'badd') {
      e.stopPropagation();
      browseAddFavorite(e.target.getAttribute('data-slug'));
      return;
    }
    var c = browseCardFromEvent(e);
    if (c) { browse.zone = 'grid'; browse.gridIdx = c.idx; browseActivate(); }
  });
  browseGrid.addEventListener('wheel', function (e) {
    if (!browse.open) return;
    e.preventDefault();
    browseGrid.scrollTop += (e.deltaY > 0 ? 1 : -1) * 160;
    if (browseGrid.scrollTop + browseGrid.clientHeight >= browseGrid.scrollHeight - 500) loadBrowseMore(false);
  });
  document.getElementById('browse-close').addEventListener('click', function () { closeBrowse(); });
  // Settings gear and its menu
  var gear = document.getElementById('quality-gear');
  if (gear) gear.addEventListener('click', function (e) { e.stopPropagation(); openSettings(); });
  var slist = document.getElementById('settings-list');
  function sRowIdx(e) {
    var el = e.target;
    while (el && el !== slist && !(el.getAttribute && el.getAttribute('data-focusable'))) el = el.parentNode;
    if (!el || el === slist) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) ? -1 : i;
  }
  slist.addEventListener('mouseover', function (e) {
    var i = sRowIdx(e);
    if (i >= 0 && i !== settings.focus) { settings.focus = i; applySettingsFocus(); }
  });
  slist.addEventListener('click', function (e) {
    var i = sRowIdx(e);
    if (i >= 0) { settings.focus = i; applySettingsFocus(); settingsActivate(); }
  });
  document.getElementById('settingsmodal').addEventListener('click', function (e) {
    if (e.target === this) closeSettings();
  });
  // A pointer move anywhere counts as activity for the burn-in guard.
  document.addEventListener('mousemove', function () { markInput(); });
})();

/* Watching the video element for trouble */
(function wireVideo() {
  var video = document.getElementById('video');
  video.addEventListener('error', function () {
    if (PB.active && state.current) recoverPlayback(state.current);
  });
  video.addEventListener('ended', function () {
    if (PB.active && state.current) recoverPlayback(state.current); // a live stream should not just end
  });
  video.addEventListener('playing', function () {
    PB.stallCount = 0; PB.netRetries = 0; PB.mediaRetries = 0; setBanner('');
  });
})();

// While we are idle and cannot reach Kick, retry a little quicker than the
// normal thirty second poll. It stops on its own and never piles up.
function scheduleDownRetry() {
  if (state.downRetry) return;
  state.downRetry = true;
  (function loop() {
    setTimeout(function () {
      if (state.current || !state.netDown) { state.downRetry = false; return; }
      fetchFavorites(function () {
        if (state.sidebarOpen) renderSidebar();
        if (!state.current) showNothing();
        if (state.netDown && !state.current) loop(); else state.downRetry = false;
      });
    }, 8000);
  })();
}

/* Startup */
document.addEventListener('visibilitychange', function () {
  if (document.hidden) return;
  fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(); });
  if (PB.active && state.current) recoverPlayback(state.current); // back in the app, check the stream is fine
});
// Handle the network coming back or dropping out.
window.addEventListener('online', function () {
  fetchFavorites(function () {
    if (state.sidebarOpen) renderSidebar();
    if (state.ready && !state.current) showNothing();
  });
  if (PB.active && state.current) recoverPlayback(state.current);
  else if (state.netDown) scheduleDownRetry();
});
window.addEventListener('offline', function () {
  setNetDown(true);
  if (state.sidebarOpen) renderSidebar();
});
(function boot() {
  setMode('player');
  loadQualityPref();
  loadSettings();
  state.lastInput = Date.now();
  setInterval(checkSaver, 20000);             // burn-in guard checks in every 20s
  showState('splash');
  startPlayerPoll();
  fetchFavorites(function () {
    state.ready = true;                       // first load is done, start letting input through
    var last = loadLast();
    var target = (last && state.channels[last] && state.channels[last].live) ? last : firstLive();
    if (target) { play(target); return; }
    // Nothing to play. On a fresh, empty setup, open the live browser so there
    // is something to pick from right away; otherwise show the idle screen.
    if (!getFavorites().length && !state.netDown) {
      showState('empty');
      openBrowse();
    } else {
      showNothing();
      if (state.netDown) scheduleDownRetry();
    }
  });
})();
