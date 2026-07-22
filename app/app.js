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
  quitTimer: null
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
    playbackUrl: raw.playback_url || null
  };
}
function offlineStub(slug) {
  return { slug: slug, name: slug, live: false, viewers: 0, title: '',
           category: '', avatar: null, playbackUrl: null };
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
  PB.slug = null;
  setBanner('');
  showNothing();
}
function play(slug) {
  if (!slug) return;
  teardownVideo();
  setMode('player');
  state.current = slug;
  PB.slug = slug; PB.reloading = false; PB.netRetries = 0; PB.mediaRetries = 0;
  setBanner('');
  showState('hidden');
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
      toast(c.name + ' is offline');
      returnToIdle();
      return;
    }
    saveLast(slug);
    if (isRecovery) setBanner('');
    else { showOverlay(c); if (state.sidebarOpen) renderSidebar(slug); }
    attachStream(slug, c.playbackUrl);
  });
}
function attachStream(slug, url) {
  var video = document.getElementById('video');
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  PB.netRetries = 0; PB.mediaRetries = 0;
  if (window.Hls && Hls.isSupported()) {
    var hls = new Hls({
      enableWorker: true, capLevelToPlayerSize: true, maxBufferLength: 30,
      manifestLoadingMaxRetry: 4, manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 4, levelLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000
    });
    state.hls = hls;
    hls.on(Hls.Events.ERROR, function (ev, data) {
      if (state.hls !== hls || !data || !data.fatal) return;   // old stream, or not fatal, so ignore
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) onNetworkError(slug, hls);
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) onMediaError(slug, hls);
      else recoverPlayback(slug);                              // nothing we can patch, reload it all
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
function openSidebar() {
  if (!state.ready) return;
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
  // pull fresh data every time the list is opened
  fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(); });
}
function closeSidebar() {
  clearTimeout(state.idleTimer);
  if (!state.sidebarOpen) return;
  state.sidebarOpen = false;
  document.getElementById('sidebar').className = '';
  document.getElementById('overlay').className = 'hidden';
  clearTimeout(overlayTimer);
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
  if (!state.ready || state.mode !== 'player') return;
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

  state.sideItems = state.order.map(function (s) { return { type: 'chan', slug: s }; });
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
    var slug = item.slug, c = state.channels[slug], pinned = isPinned(slug);
    var base = 'favrow' + (c.live ? '' : ' offline') +
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
    act.innerHTML =
      '<span class="actbtn pinbtn' + (pinned ? ' on' : '') + '" data-act="pin">' + pinIcon() + '</span>' +
      '<span class="actbtn rmbtn" data-act="remove">✕</span>';
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
function refreshSide() {
  var btn = document.getElementById('side-refresh');
  btn.className = 'spinning';
  var done = false, minned = false;
  function stop() { if (done && minned) btn.className = ''; }
  setTimeout(function () { minned = true; stop(); }, 700); // keep it spinning for at least one full turn
  fetchFavorites(function () {
    if (state.sidebarOpen) renderSidebar();
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
  if (!state.ready) { e.preventDefault(); return; } // still on the splash, ignore input until data is ready
  if (k !== KEY.BACK && k !== KEY.STOP) state.quitArmed = false; // anything but Back cancels a pending exit
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
  if (state.sidebarOpen) {
    resetIdle();
    if (k === KEY.UP) moveSide(-1);
    else if (k === KEY.DOWN) moveSide(1);
    else if (k === KEY.OK || k === KEY.RIGHT) activateSide();
    else if (k === KEY.LEFT) closeSidebar();
    else if (k === KEY.BACK) { closeSidebar(); hideCursor(); } // close the list and hide the pointer
    return;
  }
  if (k === KEY.BACK || k === KEY.STOP) { armOrExit(); return; }
  if (k === KEY.LEFT) openSidebar();
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
  showState('splash');
  startPlayerPoll();
  fetchFavorites(function () {
    state.ready = true;                       // first load is done, start letting input through
    var last = loadLast();
    var target = (last && state.channels[last] && state.channels[last].live) ? last : firstLive();
    if (target) { play(target); return; }
    showNothing();
    if (state.netDown) scheduleDownRetry();
  });
})();
