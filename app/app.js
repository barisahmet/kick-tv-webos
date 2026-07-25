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
            PLAY: 415, PAUSE: 19, STOP: 413, REW: 412, FF: 417, N0: 48 };

var state = {
  mode: 'player',        // which screen is showing: player, add, or confirm
  order: [],             // channel names in the order they appear in the list
  channels: {},          // channel name to the data we fetched for it
  hls: null,
  current: null,         // the channel playing right now, or null when nothing is on
  sidebarOpen: false,
  sideItems: [],         // the rows in the sidebar, with the Add row at the end
  sideFocus: 0,          // which sidebar row is highlighted
  playerToolFocus: -1,   // -1 = channel list, 0 = Quality, 1 = Settings
  playerTimer: null,
  toastTimer: null,
  idleTimer: null,       // closes the sidebar again once you stop touching it
  notifyTimer: null,
  notifyWaitTimer: null,
  notifyQueue: [],
  notifyCurrent: null,
  wasLive: {},           // who was live last time, so we can tell when someone comes online
  baselineSet: false,    // the first load only records live status, so we do not alert for everyone
  netDown: false,        // true when the last refresh could not reach Kick at all
  downRetry: false,      // true while a quick retry is already queued, so we do not stack them
  ready: false,          // false until the first load finishes; the splash ignores input until then
  quitArmed: false,      // set after the first Back press, so the next Back exits
  quitTimer: null,
  tempChannel: null,     // a browsed channel that is playing but not in the follow list
  lastFetch: 0,          // when favorites were last refreshed (to avoid redundant fetches)
  vod: null,             // set to a past-video descriptor while a VOD is playing
  vodReturn: null,       // the live channel to go back to when the VOD ends or you exit
  preserveLastVodDuringLive: false,
  vodRecoveryInFlight: false,
  vodRecoveryRetryTimer: null,
  offlineExpanded: false,
  suppressNudgeUntil: 0  // after a deliberate hide, pointer moves will not reopen the UI until this time
};
var IDLE_MS = 5000;
var NUDGE_SUPPRESS_MS = 10000;   // grace after click/Back hides the sidebar

// Playback state and the numbers that control how we recover from drops.
var PB = { slug: null, active: false, reloading: false,
           netRetries: 0, mediaRetries: 0,
           recoverCount: 0, reconnects: 0, lastError: '',
           watchdog: null, reconnectTimer: null, lastTime: -1, stallCount: 0,
           userSeekUntil: 0, rewound: false };
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
  var pinned = getPinned(), pi = pinned.indexOf(slug);
  if (pi !== -1) { pinned.splice(pi, 1); savePinned(pinned); }
}
// isPinned is asked a few hundred times per sortOrder pass — twice per
// comparison — so the parsed list is kept around rather than re-read and
// re-parsed each time. Every write goes through savePinned, which is the whole
// invalidation story: do not lsSet('kicktv.pinned', ...) anywhere else.
var pinnedMemo = null;
function getPinned() {
  if (!pinnedMemo) pinnedMemo = lsGet('kicktv.pinned');
  return pinnedMemo;
}
function savePinned(list) {
  pinnedMemo = list;          // what we are about to persist is what readers should see
  lsSet('kicktv.pinned', list);
}
function isPinned(slug) { return getPinned().indexOf(slug) !== -1; }
function togglePin(slug) {
  var pinned = getPinned(), i = pinned.indexOf(slug);
  if (i === -1) pinned.push(slug); else pinned.splice(i, 1);
  savePinned(pinned);
  return i === -1; // true if we just pinned it, false if we just unpinned it
}
function saveLast(slug) { try { localStorage.setItem('kicktv.last', slug); } catch (e) {} }
function loadLast() { try { return localStorage.getItem('kicktv.last'); } catch (e) { return null; } }

/* Cached channel list. The last successful refresh is persisted so the next
   launch can render the sidebar and home screen instantly while the real fetch
   runs. Playback URLs are never cached (they expire), so cached entries can be
   shown but never played from directly — startup still waits for fresh data. */
function saveChannelCache() {
  try {
    var out = { version: 1, updated: Date.now(), order: state.order, channels: {} };
    for (var i = 0; i < state.order.length; i++) {
      var s = state.order[i], c = state.channels[s];
      if (!c) continue;
      out.channels[s] = { slug: s, name: c.name, avatar: c.avatar, live: c.live,
                          viewers: c.viewers, title: c.title, category: c.category,
                          categorySlug: c.categorySlug || '', startedAt: c.startedAt || null,
                          playbackUrl: null, chatroomId: c.chatroomId || null };
    }
    localStorage.setItem('kicktv.channelcache', JSON.stringify(out));
  } catch (e) {}
}
function loadChannelCache() {
  try {
    var data = JSON.parse(localStorage.getItem('kicktv.channelcache'));
    if (!data || data.version !== 1 || !data.channels) return;
    var favs = getFavorites(), order = [];
    for (var i = 0; i < (data.order || []).length; i++) {
      var s = data.order[i];
      if (favs.indexOf(s) !== -1 && data.channels[s]) {
        state.channels[s] = data.channels[s];
        order.push(s);
      }
    }
    state.order = order;
  } catch (e) {}
}

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
    categorySlug: cats && cats[0] ? (cats[0].slug || '') : '',
    startedAt: live ? (raw.livestream.created_at || null) : null,
    playbackUrl: raw.playback_url || null,
    chatroomId: (raw.chatroom && raw.chatroom.id) || null
  };
}
function offlineStub(slug) {
  return { slug: slug, name: slug, live: false, viewers: 0, title: '',
           category: '', avatar: null, playbackUrl: null, chatroomId: null };
}
// Order the list into four groups: pinned-and-live first, then the rest of the
// live ones by viewer count, then pinned-but-offline, then everyone else
// offline. The two offline groups are alphabetical.
function sortOrder(favs) {
  // 0 pinned-live, 1 live, 2 blocked-live, 3 pinned-offline, 4 offline.
  // A blocked live channel ignores its pin — that is the point of blocking.
  function grp(c) {
    if (c.live) return isChannelBlocked(c) ? 2 : (isPinned(c.slug) ? 0 : 1);
    return isPinned(c.slug) ? 3 : 4;
  }
  state.order = favs.slice().sort(function (a, b) {
    var ca = state.channels[a], cb2 = state.channels[b];
    var ga = grp(ca), gb = grp(cb2);
    if (ga !== gb) return ga - gb;
    if (ga >= 3) return ca.name.toLowerCase() < cb2.name.toLowerCase() ? -1 : 1;   // offline: alphabetical
    return cb2.viewers - ca.viewers;                            // live, blocked included: by viewers
  });
}
// Cap how many channel lookups are in flight at once. Firing all of them together
// (24+ concurrent PalmServiceBridge calls -> that many simultaneous TLS handshakes to
// Cloudflare in the service) overwhelmed the bus and stalled some requests all the way
// to their timeouts, so boot could sit on the splash for 30s+. A small pool keeps every
// request fast and reliable while still finishing the whole list in a second or two.
var FETCH_CONCURRENCY = 5;
var fetchGeneration = 0;   // stamps each refresh so a slow old one cannot overwrite a newer one
// Refreshes are serialized: one in flight, at most one queued follow-up. Boot,
// visibility, online and retry triggers used to pile overlapping 28-request
// fetches onto the Luna bus until it crawled; now they collapse into a single
// follow-up pass whose callbacks all fire on fresh data.
var fetchInFlight = false;
var fetchFollowUp = null;
function fetchFavorites(done, liveOnly) {
  done = done || function () {};
  if (fetchInFlight) {
    if (!fetchFollowUp) fetchFollowUp = [];
    fetchFollowUp.push(done);          // wants data fresher than the pass underway
    return;
  }
  fetchInFlight = true;
  runFetchFavorites(function () {
    fetchInFlight = false;
    done();
    var queued = fetchFollowUp;
    fetchFollowUp = null;
    if (queued && queued.length) {
      fetchFavorites(function () {     // follow-up passes are always full
        for (var i = 0; i < queued.length; i++) queued[i]();
      });
    }
  }, liveOnly);
}
function runFetchFavorites(done, liveOnly) {
  var favs = getFavorites(), ok = 0, hard = 0, started = 0, finished = 0;
  var gen = ++fetchGeneration;
  if (!favs.length) { state.order = []; state.baselineSet = true; setNetDown(false); done(); return; }
  // A liveOnly pass re-checks just the channels that can change the screen
  // fast (currently live, or never fetched); offline ones keep cached data
  // until the next full pass.
  var targets = favs;
  if (liveOnly) {
    targets = [];
    for (var ti = 0; ti < favs.length; ti++) {
      var tc = state.channels[favs[ti]];
      if (!tc || tc.live) targets.push(favs[ti]);
    }
    if (!targets.length) { done(); return; }
  }
  var total = targets.length;
  function onOne(slug, err, raw) {
    var stale = gen !== fetchGeneration;
    if (!err) { if (!stale) state.channels[slug] = normalize(slug, raw); ok++; }
    else {
      if (err !== 404) hard++;         // a 404 is a definitive answer, not a connectivity failure
      if (!stale) {
        if (err === 404) {             // channel is gone: drop stale live data but keep its name
          var old = state.channels[slug];
          state.channels[slug] = offlineStub(slug);
          if (old && old.name) state.channels[slug].name = old.name;
        } else if (!state.channels[slug]) state.channels[slug] = offlineStub(slug);
      }
    }
    if (++finished === total) {
      if (gen !== fetchGeneration) { done(); return; }  // a newer refresh owns the shared state now
      if (!liveOnly) state.lastFetch = Date.now();      // partial passes don't count as fresh-everything
      // Only a full pass has seen every channel, so only a full pass may declare us
      // offline. A liveOnly pass samples a handful of channels; one of them failing
      // says nothing about the rest. It can still clear the flag, because a single
      // success is proof we reached Kick.
      if (!liveOnly) setNetDown(ok === 0 && hard > 0);
      else if (ok > 0) setNetDown(false);
      sortOrder(favs); detectOnline(favs); saveChannelCache(); done();
    } else {
      pump();                          // a slot freed up — start the next one
    }
  }
  function pump() {
    while (started < total && (started - finished) < FETCH_CONCURRENCY) {
      (function (slug) { apiGet(slug, function (err, raw) { onOne(slug, err, raw); }); })(targets[started++]);
    }
  }
  pump();
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
    if (state.baselineSet && c.live && state.wasLive[slug] === false) {
      // respect the Live alerts setting: All, Pinned only, or Off
      if (settings.alerts === 'all' || (settings.alerts === 'pinned' && isPinned(slug))) {
        newly.push({ slug: slug, name: c.name });
      }
    }
    state.wasLive[slug] = c.live;
  });
  state.baselineSet = true;
  if (newly.length) notifyOnline(newly);
}
function alertAllowed(item) {
  if (!item || settings.alerts === 'off' || getFavorites().indexOf(item.slug) === -1) return false;
  var c = state.channels[item.slug];
  if (!c || !c.live) return false;
  if (isChannelBlocked(c)) return false;   // a blocked category never interrupts
  return settings.alerts === 'all' || (settings.alerts === 'pinned' && isPinned(item.slug));
}
function notifyUiBusy() {
  return document.hidden || saver.on || !state.ready || state.mode !== 'player' || state.sidebarOpen ||
    browse.open || vods.open || cats.open || settings.open || dimopt.open ||
    chatopt.open || blockedcats.open || (qualityopt && qualityopt.open) || updateopen || chpop.open;
}
function notifyOnline(items) {
  items.forEach(function (item) {
    if (!alertAllowed(item)) return;
    if (state.notifyCurrent && state.notifyCurrent.slug === item.slug) return;
    for (var i = 0; i < state.notifyQueue.length; i++) {
      if (state.notifyQueue[i].slug === item.slug) return;
    }
    state.notifyQueue.push(item);
  });
  pumpNotify();
}
function pumpNotify() {
  if (state.notifyCurrent || !state.notifyQueue.length) return;
  if (notifyUiBusy()) {
    clearTimeout(state.notifyWaitTimer);
    state.notifyWaitTimer = setTimeout(pumpNotify, 500);
    return;
  }
  var item = null;
  while (state.notifyQueue.length && !item) {
    var candidate = state.notifyQueue.shift();
    if (alertAllowed(candidate)) item = candidate;
  }
  if (!item) return;
  state.notifyCurrent = item;
  var el = document.getElementById('notify');
  el.innerHTML = '<span class="ndot"></span>';
  el.appendChild(document.createTextNode(item.name + ' is online'));
  var hint = document.createElement('span');
  hint.className = 'nhint';
  hint.textContent = 'Press OK to watch';
  el.appendChild(hint);
  el.style.filter = settings.dim && settings.dimScope !== 'all' ? popupDimFilter() : '';
  el.className = 'show';
  clearTimeout(state.notifyTimer);
  state.notifyTimer = setTimeout(expireNotify, 5000);
}
// The 5s lifetime is up. If a popup slid over the alert meanwhile, requeue it
// so it comes back visible and actionable instead of expiring unseen.
function expireNotify() {
  if (state.notifyCurrent && notifyUiBusy()) { pauseNotify(); return; }
  finishNotify();
}
function finishNotify() {
  clearTimeout(state.notifyTimer);
  state.notifyTimer = null;
  state.notifyCurrent = null;
  document.getElementById('notify').className = '';
  clearTimeout(state.notifyWaitTimer);
  state.notifyWaitTimer = setTimeout(pumpNotify, 260);
}
function pauseNotify() {
  clearTimeout(state.notifyTimer);
  clearTimeout(state.notifyWaitTimer);
  state.notifyTimer = null;
  state.notifyWaitTimer = null;
  if (state.notifyCurrent) {
    state.notifyQueue.unshift(state.notifyCurrent);
    state.notifyCurrent = null;
  }
  document.getElementById('notify').className = '';
  state.notifyWaitTimer = setTimeout(pumpNotify, 500);   // resume once the UI is free again
}
function activateNotify() {
  var item = state.notifyCurrent;
  if (!item) return false;
  finishNotify();
  if (!alertAllowed(item)) { toast('Channel is no longer live'); return true; }
  if (state.current === item.slug) {
    if (state.channels[item.slug]) showOverlay(state.channels[item.slug]);
    return true;
  }
  closeSidebar();
  play(item.slug);
  return true;
}
function pruneNotifications() {
  var kept = [];
  for (var i = 0; i < state.notifyQueue.length; i++) {
    if (alertAllowed(state.notifyQueue[i])) kept.push(state.notifyQueue[i]);
  }
  state.notifyQueue = kept;
  if (state.notifyCurrent && !alertAllowed(state.notifyCurrent)) finishNotify();
  else pumpNotify();
}
function fmtViewers(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return String(n);
}
// Kick timestamps are UTC "YYYY-MM-DD HH:MM:SS" (sometimes with a T).
function parseKickTime(str) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}
// How long a stream has been live.
function fmtUptime(str) {
  var t = parseKickTime(str);
  if (!t) return '';
  var mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just started';
  if (mins < 60) return 'live ' + mins + 'm';
  return 'live ' + Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}
// The little pushpin. It is filled with currentColor so the CSS decides whether
// it looks green (pinned) or grey (the button you see on hover).
function pinIcon() {
  return '<svg class="pinicon" viewBox="0 0 24 24" fill="currentColor">' +
         '<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H19v-2l-3-2z"/></svg>';
}
// A circle with a slash, drawn the same way as pinIcon so CSS picks the colour.
function blockIcon() {
  return '<svg class="blockicon" viewBox="0 0 24 24" fill="currentColor">' +
         '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 2c1.85 0 3.55.63 4.9 1.69' +
         'L5.69 16.9A7.96 7.96 0 0112 4zm0 16a7.96 7.96 0 01-4.9-1.69L18.31 7.1' +
         'A7.96 7.96 0 0112 20z"/></svg>';
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
  document.getElementById('home').className = 'hidden';   // showNothing re-shows it when idle
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
  if (state.vod) return;                 // a past video is playing; never show an idle screen over it
  var m = idleModeForNothing();
  showState(m);
  if (m === 'offline' || m === 'available') {   // mini home: continue watching + live tiles
    renderHome();
    document.getElementById('home').className = '';
  }
  if (m === 'empty' && state.ready) openSidebar();
}
// In-progress recordings from the progress store, newest first: everything
// resumable (>=10s in, not watched), each row knowing its channel and video id.
function listResumableVods(max) {
  var items = loadVodProgress().items, out = [];
  for (var k in items) {
    if (!Object.prototype.hasOwnProperty.call(items, k)) continue;
    var e = items[k];
    if (!e || e.watched || !(e.position >= 10)) continue;
    var ci = k.indexOf(':');
    if (ci <= 0) continue;
    out.push({ key: k, slug: k.slice(0, ci), id: k.slice(ci + 1), entry: e });
  }
  out.sort(function (a, b) { return (b.entry.updated || 0) - (a.entry.updated || 0); });
  return out.slice(0, max || 4);
}
// Resolve a saved recording against a fresh videos list (URLs expire) and play it.
function openSavedVod(slug, id) {
  if (!state.ready || state.current || state.vod) return;
  document.getElementById('idle-load').className = '';
  serviceGet('/api/v2/channels/' + encodeURIComponent(slug) + '/videos', function (err, data) {
    document.getElementById('idle-load').className = 'hidden';
    if (state.current || state.vod) return;        // something else started meanwhile
    var list = (Array.isArray(data) ? data : []).filter(playableVod);
    for (var i = 0; i < list.length; i++) {
      if (vodStableId(list[i]) === String(id)) {
        vods.slug = slug; vods.list = list; vods.gridIdx = i;
        state.vodReturn = state.current || state.vodReturn;
        playVod(list[i], list.slice(), i, slug);
        return;
      }
    }
    toast(err ? 'Could not load that video' : 'That video is no longer available');
    if (!err) { clearVodProgress(slug + ':' + String(id)); renderHome(); }
  });
}
// The mini home screen shown on the idle screen: a row of resumable recordings
// (Continue Watching) and a row of live favorites.
function renderHome() {
  var resumables = listResumableVods(4);
  var cwrap = document.getElementById('home-continue');
  var vrow = document.getElementById('home-resume-row');
  vrow.innerHTML = '';
  if (resumables.length) {
    for (var ri = 0; ri < resumables.length; ri++) {
      var r = resumables[ri];
      var card = document.createElement('div');
      card.className = 'homevod';
      card.setAttribute('data-slug', r.slug);
      card.setAttribute('data-vid', r.id);
      var nm = document.createElement('div'); nm.className = 'homename';
      nm.textContent = r.entry.name || (state.channels[r.slug] && state.channels[r.slug].name) || r.slug;
      card.appendChild(nm);
      if (r.entry.title) {
        var ti = document.createElement('div'); ti.className = 'homesub';
        ti.textContent = r.entry.title;
        card.appendChild(ti);
      }
      var sub = document.createElement('div'); sub.className = 'homesub';
      sub.textContent = fmtClock(r.entry.position) +
        (r.entry.duration ? ' / ' + fmtClock(r.entry.duration) : '');
      card.appendChild(sub);
      if (r.entry.duration > 0) {
        var tr = document.createElement('div'); tr.className = 'homeprog';
        var fl = document.createElement('div'); fl.className = 'homeprogfill';
        fl.style.width = Math.round(Math.min(1, r.entry.position / r.entry.duration) * 100) + '%';
        tr.appendChild(fl);
        card.appendChild(tr);
      }
      vrow.appendChild(card);
    }
    cwrap.className = '';
  } else cwrap.className = 'hidden';
  var row = document.getElementById('home-live-row');
  row.innerHTML = '';
  var shown = 0;
  for (var i = 0; i < state.order.length && shown < 5; i++) {
    var s = state.order[i], c = state.channels[s];
    if (!c || !c.live) continue;
    shown++;
    var t = document.createElement('div');
    t.className = 'hometile';
    t.setAttribute('data-slug', s);
    var av = document.createElement('div'); av.className = 'homeav';
    if (c.avatar) av.style.backgroundImage = 'url(' + c.avatar + ')';
    else av.textContent = (c.name || s).charAt(0).toUpperCase();
    t.appendChild(av);
    var hn = document.createElement('div'); hn.className = 'hometname'; hn.textContent = c.name;
    t.appendChild(hn);
    var hv = document.createElement('div'); hv.className = 'hometsub';
    hv.textContent = fmtViewers(c.viewers) + (c.category ? ' · ' + c.category : '');
    t.appendChild(hv);
    row.appendChild(t);
  }
  document.getElementById('home-live').className = shown ? '' : 'hidden';
}
function setBanner(msg) {
  var el = document.getElementById('pbstatus');
  if (!el) return;
  if (!msg) { el.className = 'hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className = '';
  hideSpinner();                 // the reconnecting banner replaces the plain buffering spinner
}
function teardownVideo() {
  saveVodProgress(true);          // capture the old VOD before its media/state is replaced
  saveLiveMark(true);             // ...and where we were in a live stream, for its recording
  resetSeekAccum();               // a queued seek belongs to the source being torn down
  PB.active = false;
  hideVodBar();
  hideSpinner();
  hideVodPlay();
  stopWatchdog();
  if (PB.reconnectTimer) { clearTimeout(PB.reconnectTimer); PB.reconnectTimer = null; }
  var video = document.getElementById('video');
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
}
function returnToIdle() {
  teardownVideo();
  state.current = null;
  state.vod = null; state.vodReturn = null;
  state.tempChannel = null;
  PB.slug = null;
  setBanner('');
  updateGear();
  disconnectChat();
  showNothing();
}
function play(slug, preserveLastVod, prefetchedRaw) {
  if (!slug) return;
  teardownVideo();
  disconnectChat();          // drop the old channel's chat; the new one connects once it loads
  state.vod = null; state.vodReturn = null;   // leaving any past-video playback
  setMode('player');
  state.current = slug;
  state.preserveLastVodDuringLive = !!preserveLastVod;
  // if it is not one of your channels, it shows in the sidebar as a temporary row
  state.tempChannel = (getFavorites().indexOf(slug) === -1) ? slug : null;
  PB.slug = slug; PB.session = (PB.session || 0) + 1; PB.reloading = false; PB.netRetries = 0; PB.mediaRetries = 0;
  PB.recoverCount = 0; PB.endedCount = 0; PB.reconnects = 0; PB.lastError = '';
  PB.userSeekUntil = 0; PB.rewound = false;
  setBanner('');
  showState('hidden');
  updateGear();
  loadChannel(slug, false, prefetchedRaw);
}
// Fetch the channel again, which also hands us a fresh playback link since the
// old one expires after a while, then start the video. A caller that already
// holds a fresh response (boot quick-start) passes it in and skips the fetch.
function loadChannel(slug, isRecovery, prefetchedRaw) {
  var session = PB.session;            // the playback session this load belongs to
  function handle(err, raw) {
    if (state.current !== slug || session !== PB.session) return;  // switched away, or an older session for the same channel
    PB.reloading = false;
    if (err) {
      if (isRecovery) { scheduleReconnect(slug); return; }  // a recovery try failed, so keep trying
      toast('Kick API unreachable');
      returnToIdle();
      return;
    }
    var c = normalize(slug, raw);
    state.channels[slug] = c;
    if (!c.live || !c.playbackUrl) { advanceOrIdle(slug); return; }   // stream ended / offline
    saveLast(slug);
    // An automatic live fallback after a transient VOD lookup failure must not
    // erase Continue Watching. A deliberate live choice calls play() without
    // this flag and becomes the next startup choice once it really starts.
    if (!state.preserveLastVodDuringLive) clearLastVod();
    if (isRecovery) setBanner('');
    else { showOverlay(c); if (state.sidebarOpen) renderSidebar(slug); }
    attachStream(slug, c.playbackUrl);
    syncChat();                                  // connect chat for this channel if it is enabled
  }
  if (prefetchedRaw) { handle(null, prefetchedRaw); return; }
  apiGet(slug, handle);
}
function attachStream(slug, url) {
  var video = document.getElementById('video');
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  PB.netRetries = 0; PB.mediaRetries = 0;
  PB.userSeekUntil = 0; PB.rewound = false;
  liveWatchStartedMs = Date.now();   // a fresh live session to mark
  liveMarkLastWrite = 0;
  try { video.playbackRate = 1; } catch (e) {}
  if (window.Hls && Hls.isSupported()) {
    var hls = new Hls(hlsConfig());
    state.hls = hls;
    hls.on(Hls.Events.ERROR, function (ev, data) {
      if (data && data.details) PB.lastError = data.details;
      if (state.hls !== hls || !data || !data.fatal) return;   // old stream, or not fatal, so ignore
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) onNetworkError(slug, hls);
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) onMediaError(slug, hls);
      else recoverPlayback(slug);                              // nothing we can patch, reload it all
    });
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      if (state.hls !== hls) return;                           // a newer stream took over
      applyQualityPref();                                      // honour the saved quality choice
      if (qualityopt && qualityopt.open) refreshQualityOpt();
    });
    if (Hls.Events.LEVEL_SWITCHED) {
      hls.on(Hls.Events.LEVEL_SWITCHED, function () {
        if (state.hls === hls) updateQualityButton();
      });
    }
    if (Hls.Events.FRAG_LOADED) {
      hls.on(Hls.Events.FRAG_LOADED, function (ev, d) { diagCountFrag(d); });
    }
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
var resumeWasPaused = false;   // was the video already paused when the popup opened?
function pausePlaybackForBrowse() {
  var v = document.getElementById('video');
  resumeWasPaused = !!v.paused;
  try { v.pause(); } catch (e) {}
  if (state.hls) { try { state.hls.stopLoad(); } catch (e) {} }
  stopWatchdog();
}
function resumePlaybackAfterBrowse() {
  if (!state.current && !state.vod) return;
  if (state.hls) { try { state.hls.startLoad(); } catch (e) {} }
  if (!resumeWasPaused) playVideo(document.getElementById('video'));   // respect a deliberate pause
  if (state.current) startWatchdog(state.current);   // VODs run without the live watchdog
}
function onNetworkError(slug, hls) {
  if (state.current !== slug) return;
  PB.netRetries++;
  if (PB.netRetries <= MAX_NET_RETRY) {
    setBanner('Reconnecting...');
    try { hls.startLoad(); } catch (e) { recoverPlayback(slug); }
  } else {
    recoverPlayback(slug);                        // retried enough, the link probably expired, get a new one
  }
}
function onMediaError(slug, hls) {
  if (state.current !== slug) return;
  PB.mediaRetries++;
  if (PB.mediaRetries <= MAX_MEDIA_RETRY) {
    setBanner('Recovering...');
    try { hls.recoverMediaError(); } catch (e) { recoverPlayback(slug); }
  } else {
    recoverPlayback(slug);
  }
}
// Last resort. Throw away the current stream and load the channel from scratch
// with a new playback link.
function recoverPlayback(slug) {
  if (state.current !== slug || PB.reloading) return;
  PB.recoverCount = (PB.recoverCount || 0) + 1;
  PB.reconnects++;
  if (PB.recoverCount > 3) { advanceOrIdle(slug); return; }   // it keeps failing: treat as ended
  PB.reloading = true;
  setBanner('Reconnecting...');
  stopWatchdog();
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  loadChannel(slug, true);
}
// Move on when a live stream ends: hop to the next live favorite if auto-advance
// is on, otherwise show the idle screen.
// The hop budget lives outside PB because play() resets every PB counter, so
// without it two channels that Kick reports live but the TV cannot decode would
// hand each other back and forth forever.
var MAX_AUTO_ADVANCE = 3;
var autoAdvanceRun = 0;
function advanceOrIdle(slug) {
  if (settings.autoadvance && autoAdvanceRun < MAX_AUTO_ADVANCE) {
    // prefer a live pinned channel, then fall back to the next live one
    var nx = firstLivePinned(slug) || nextLiveAfter(slug);
    if (nx) {
      autoAdvanceRun++;
      toast('Auto-advancing to ' + (state.channels[nx].name || nx));
      play(nx, state.preserveLastVodDuringLive);
      return;
    }
  }
  autoAdvanceRun = 0;          // this chain is over; the next stream end gets a fresh budget
  toast(((state.channels[slug] && state.channels[slug].name) || slug) + ' ended');
  returnToIdle();
  // Leave the viewer something actionable: the list of who else is live. This
  // popup is persistent (no auto-hide) and refreshes with the 30s poll.
  if (state.ready && liveList().length) openChpopPersistent();
}
// A live stream that fires 'ended' has almost certainly stopped. Verify once and
// move on if it is offline; give a single retry if the API still lags behind.
function handleEnded(slug) {
  if (state.current !== slug || !PB.active) return;
  PB.endedCount = (PB.endedCount || 0) + 1;
  if (PB.endedCount >= 2) { advanceOrIdle(slug); return; }
  var session = PB.session;
  apiGet(slug, function (err, raw) {
    if (state.current !== slug || session !== PB.session) return;
    var live = !err && raw && raw.livestream && raw.livestream.is_live && raw.playback_url;
    if (!live) { advanceOrIdle(slug); return; }
    state.channels[slug] = normalize(slug, raw);
    attachStream(slug, raw.playback_url);
  });
}
function scheduleReconnect(slug) {
  setBanner('Reconnecting...');
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
    if (video.seeking || Date.now() < PB.userSeekUntil) {
      PB.lastTime = video.currentTime;
      PB.stallCount = 0;
      return;
    }
    var t = video.currentTime;
    if (PB.lastTime >= 0 && Math.abs(t - PB.lastTime) < 0.05) {
      if (++PB.stallCount >= STALL_TICKS) { PB.stallCount = 0; recoverPlayback(slug); }
    } else {
      PB.stallCount = 0;
      if (PB.lastTime >= 0) {                          // real progress, not just the first tick
        PB.netRetries = 0; PB.mediaRetries = 0;
        PB.recoverCount = 0; PB.endedCount = 0;        // healthy playback: clear the give-up counters
        autoAdvanceRun = 0;                            // we landed on something that really plays
        setBanner('');                                 // it is moving again, clear the message
      }
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
  if (c && !c.live) { openVods(slug); return; }   // offline: show the channel's past videos
  closeSidebar();
  if (slug !== state.current) play(slug);
}
function openVodsForContext() {
  if (state.current) openVods(state.current);          // the channel you are watching
  else if (state.vod) openVods(state.vod.slug);        // already in a past video: same channel
  else if (state.sidebarOpen) {                        // idle: fall back to the highlighted row
    var item = state.sideItems[state.sideFocus];
    if (item && (item.type === 'chan' || item.type === 'temp')) openVods(item.slug);
  }
}
function exitApp() { try { window.close(); } catch (e) {} }
function armOrExit() {
  if (state.quitArmed) { exitApp(); return; }
  state.quitArmed = true;
  toast('Press Back again to exit');
  clearTimeout(state.quitTimer);
  state.quitTimer = setTimeout(function () { state.quitArmed = false; }, 2500);
}

var playerPollTick = 0;
function startPlayerPoll() {
  stopPlayerPoll();
  state.playerTimer = setInterval(function () {
    playerPollTick++;
    // Every third tick (90s) is a full refresh; in between, only live channels
    // are re-checked — a handful of ~50ms requests instead of the whole list.
    fetchFavorites(function () {
      if (state.sidebarOpen) renderSidebar();
      if (chpop.open && chpop.persistent) refreshChpopList();   // keep the stream-end list fresh
      if (!state.current) { if (state.ready) showNothing(); return; }
      var cur = state.channels[state.current];
      if (cur) {
        var ov = document.getElementById('overlay');
        if (ov.className.indexOf('hidden') === -1) fillOverlay(cur);
      }
    }, playerPollTick % 3 !== 0);
  }, PLAYER_REFRESH_MS);
}
function stopPlayerPoll() {
  if (state.playerTimer) { clearInterval(state.playerTimer); state.playerTimer = null; }
}

/* The info bar at the top */
var overlayTimer = null;
function setOverlayAvatar(avatarUrl, name) {
  var av = document.getElementById('ov-avatar');
  if (!av) return;
  if (avatarUrl) { av.style.backgroundImage = 'url(' + avatarUrl + ')'; av.textContent = ''; }
  else { av.style.backgroundImage = ''; av.textContent = (name || '?').charAt(0).toUpperCase(); }
}
function fillOverlay(c) {
  setOverlayAvatar(c.avatar, c.name);
  document.getElementById('ov-name').textContent = c.name;
  var up = c.live && c.startedAt ? fmtUptime(c.startedAt) : '';
  document.getElementById('ov-viewers').textContent =
    c.live ? (fmtViewers(c.viewers) + ' viewers' + (up ? ' · ' + up : '')) : 'Offline';
  // The category is a clickable chip: clicking it opens Browse filtered to it.
  var titleEl = document.getElementById('ov-title');
  titleEl.innerHTML = '';
  if (c.category) {
    var cat = document.createElement('span');
    cat.className = 'ovcat';
    if (c.categorySlug) cat.setAttribute('data-catslug', c.categorySlug);
    cat.textContent = c.category;
    titleEl.appendChild(cat);
    if (c.title) titleEl.appendChild(document.createTextNode(' · ' + c.title));
  } else titleEl.textContent = c.title || '';
}
function showOverlay(c) {
  fillOverlay(c);
  document.getElementById('ov-live').style.display = '';   // restore the LIVE badge (VOD hides it)
  var ov = document.getElementById('overlay');
  ov.style.left = state.sidebarOpen ? '470px' : '0';
  ov.style.width = state.sidebarOpen ? '1450px' : '1920px';
  ov.className = '';
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(function () {
    if (!state.sidebarOpen) ov.className = 'hidden';  // with the sidebar open it hides on close instead
  }, 4000);
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
function applyPlayerToolFocus() {
  var qualityButton = document.getElementById('quality-button');
  var settingsButton = document.getElementById('settings-button');
  if (qualityButton) qualityButton.classList.toggle('focused', state.playerToolFocus === 0);
  if (settingsButton) settingsButton.classList.toggle('focused', state.playerToolFocus === 1);
}
function setPlayerToolFocus(idx) {
  state.playerToolFocus = idx;
  applyPlayerToolFocus();
  if (state.sidebarOpen) applySideFocus();
}
function activatePlayerTool() {
  if (state.playerToolFocus === 0) openQualityOpt();
  else if (state.playerToolFocus === 1) openSettings();
}
// The bottom player tools and colour-button legend belong to the open sidebar,
// so show them exactly when it is open.
function updateGear() {
  var open = state.sidebarOpen;
  var tools = document.getElementById('player-tools');
  if (tools) { if (open) tools.classList.remove('hidden'); else tools.classList.add('hidden'); }
  if (!open) {
    state.playerToolFocus = -1;
    hideQualityHint();
  }
  applyPlayerToolFocus();
  updateQualityButton();
  var guide = document.getElementById('cbguide');
  if (guide) { if (open) guide.classList.remove('hidden'); else guide.classList.add('hidden'); }
}
function openSidebar() {
  if (!state.ready || browse.open || vods.open || cats.open || chpop.open) return;
  state.suppressNudgeUntil = 0;                  // an explicit reopen cancels an older Back/click grace
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
  placeDiagnostics();
  prefetchSidePreviews();                             // warm live-row thumbnails for instant previews
  if (state.vod) showVodOverlay();                    // the full VOD controls ride with the sidebar
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
  sidePreviewCard.cancel();
  hideVodBar();                                       // VOD seek bar hides with the sidebar
  hideVodPlay();                                      // ...and so does the play/pause button
  updateGear();
  placeDiagnostics();
}
function closeSidebarWithGrace() {
  closeSidebar();
  state.suppressNudgeUntil = Date.now() + NUDGE_SUPPRESS_MS;
  hideCursor();
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
  if (!state.ready || state.mode !== 'player' || browse.open || vods.open || cats.open || chpop.open) return;
  // If the user just clicked to hide the UI, don't let a stray pointer move pop it
  // straight back open. They can always click again to bring it up (which clears this).
  if (!state.sidebarOpen && Date.now() < state.suppressNudgeUntil) return;
  if (!state.sidebarOpen) openSidebar(); else resetIdle();
}
function focusKeyOf(item) {
  if (!item) return null;
  if (item.type === 'add') return 'add';
  if (item.type === 'offline-group') return 'offline-group';
  return item.slug;
}
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
    row.className = row.getAttribute('data-base') +
      (i === state.sideFocus && state.playerToolFocus < 0 ? ' focused' : '');
    if (i === state.sideFocus) {
      var top = row.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top - 8;
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = top + row.offsetHeight - list.clientHeight + 8;
    }
  }
  scheduleSidePreview();
}
/* Live thumbnail previews. A card shows the stream's current frame beside the
   focused list row — used by the sidebar and the quick-switch popup. The window
   appears instantly with a loading spinner; the frame swaps in when loaded
   (usually at once, thanks to prefetching). */
var previewCache = {};   // slug -> { t, url }; v1 thumbnails live on images.kick.com, which loads directly
// The v2 payload only carries a thumbnail host the webview cannot load, so ask
// v1 for the images.kick.com variants and prefer the 480-wide one — the card is
// 426px and the smaller file arrives much faster.
function pickPreviewUrl(raw) {
  var t = raw && raw.livestream && raw.livestream.thumbnail;
  if (!t) return null;
  var m = /(https:\/\/[^\s]+\/480\.webp[^\s]*)/.exec(String(t.responsive || ''));
  return (m && m[1]) || t.url || null;
}
function fetchPreviewUrl(slug, done) {
  serviceGet('/api/v1/channels/' + encodeURIComponent(slug), function (err, raw) {
    var url = err ? null : pickPreviewUrl(raw);
    if (url) {
      if (Object.keys(previewCache).length > 16) previewCache = {};
      previewCache[slug] = { t: Date.now(), url: url };
      var img = new Image();     // warm the browser cache so presenting is instant
      img.src = url;
    }
    if (done) done();
  });
}
// Resolve and warm thumbnails for the live rows as soon as a channel list
// opens, one at a time (the Luna bus dislikes bursts), so browsing feels instant.
function prefetchSidePreviews() {
  var queue = [];
  for (var i = 0; i < state.order.length && queue.length < 8; i++) {
    var s = state.order[i], c = state.channels[s];
    if (c && c.live && s !== state.current) {
      var cached = previewCache[s];
      if (!cached || Date.now() - cached.t >= 60000) queue.push(s);
    }
  }
  (function next() {
    if (!queue.length || (!state.sidebarOpen && !chpop.open)) return;
    fetchPreviewUrl(queue.shift(), next);
  })();
}
// One controller per card element; each follows its own list's focus. Repeat
// updates for the same row are no-ops (re-renders must not flash the card).
function makePreviewCard(elId, currentSlugFn, positionFn) {
  var slugShowing = null, timer = null;
  function el() { return document.getElementById(elId); }
  function hide() {
    slugShowing = null;
    var e = el();
    if (e) e.className = 'hidden';
  }
  function setTitle(e, slug) {
    var tEl = e.querySelector('.prevtitle');
    if (!tEl) return;
    var c = state.channels[slug];
    var title = (c && c.title) || '';
    tEl.textContent = title;
    tEl.style.display = title ? '' : 'none';
  }
  function present(slug, url) {
    if (slugShowing !== slug || currentSlugFn() !== slug) return;   // focus moved meanwhile
    var e = el();
    e.style.backgroundImage = 'url(' + url + ')';
    setTitle(e, slug);
    positionFn(e);
    e.className = '';
  }
  function preload(slug, url) {
    var img = new Image();   // swap in only after a real load — never a black card
    img.onload = function () { present(slug, url); };
    img.onerror = function () { if (slugShowing === slug) hide(); };
    img.src = url;
  }
  function update() {
    var slug = currentSlugFn();
    var c = slug ? state.channels[slug] : null;
    var want = !!(slug && c && c.live && slug !== state.current);
    if (want && slug === slugShowing) return;
    clearTimeout(timer);
    if (!want) { hide(); return; }
    slugShowing = slug;
    var e = el();
    positionFn(e);
    setTitle(e, slug);      // the title is known immediately, even before the frame
    e.className = 'loading';
    var cached = previewCache[slug];
    if (cached && Date.now() - cached.t < 60000) { preload(slug, cached.url); return; }
    timer = setTimeout(function () {
      fetchPreviewUrl(slug, function () {
        var c2 = previewCache[slug];
        if (c2) preload(slug, c2.url);
        else if (slugShowing === slug) hide();   // no thumbnail: no stuck spinner
      });
    }, 150);
  }
  return { update: update, cancel: function () { clearTimeout(timer); hide(); } };
}
var sidePreviewCard = makePreviewCard('sidepreview',
  function () {
    if (!state.sidebarOpen) return null;
    var item = state.sideItems[state.sideFocus];
    return (item && (item.type === 'chan' || item.type === 'temp')) ? item.slug : null;
  },
  function (e) {
    var list = document.getElementById('fav-list');
    var row = list.children[state.sideFocus];
    var top = 200;
    if (row) {
      var r = row.getBoundingClientRect();
      top = Math.max(90, Math.min(1080 - 280, r.top - 40));
    }
    e.style.top = Math.round(top) + 'px';
  });
function scheduleSidePreview() { sidePreviewCard.update(); }
function renderSidebar(focusKey) {
  var prevKey = (typeof focusKey !== 'undefined' && focusKey !== null)
    ? focusKey : focusKeyOf(state.sideItems[state.sideFocus]);

  state.sideItems = [];
  if (state.tempChannel && state.order.indexOf(state.tempChannel) === -1 && state.channels[state.tempChannel]) {
    state.sideItems.push({ type: 'temp', slug: state.tempChannel });
  }
  if (settings.hideOffline) {
    var offline = [];
    state.order.forEach(function (s) {
      if (state.channels[s] && state.channels[s].live) state.sideItems.push({ type: 'chan', slug: s });
      else offline.push(s);
    });
    if (offline.length) {
      state.sideItems.push({ type: 'offline-group', count: offline.length });
      if (state.offlineExpanded) {
        offline.forEach(function (s) { state.sideItems.push({ type: 'chan', slug: s }); });
      }
    } else {
      state.offlineExpanded = false;
    }
  } else {
    state.order.forEach(function (s) { state.sideItems.push({ type: 'chan', slug: s }); });
  }
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
    if (item.type === 'offline-group') {
      var grow = document.createElement('div');
      grow.setAttribute('data-base', 'favrow offlinegroup');
      grow.setAttribute('data-type', 'offline-group');
      grow.className = 'favrow offlinegroup';
      var chev = document.createElement('span');
      chev.className = 'offline-chevron';
      chev.innerHTML = state.offlineExpanded
        ? '<svg viewBox="0 0 24 24"><path d="M4 8l8 8 8-8"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M8 4l8 8-8 8"/></svg>';
      var glabel = document.createElement('span');
      glabel.className = 'offline-label';
      glabel.textContent = 'Offline channels';
      var count = document.createElement('span');
      count.className = 'offline-count';
      count.textContent = String(item.count);
      grow.appendChild(chev);
      grow.appendChild(glabel);
      grow.appendChild(count);
      list.appendChild(grow);
      return;
    }
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
    // A blocked row keeps all its live information and is merely dimmed.
    var blocked = isChannelBlocked(c);
    var base = 'favrow' + (isTemp ? ' temp' : '') + (c.live ? '' : ' offline') +
               (blocked ? ' blocked' : '') +
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
    mid.children[1].textContent = c.live
      ? ((c.category || 'Live') + (c.title ? ' · ' + c.title : ''))
      : 'Offline';
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
  if (idx === -1 && settings.hideOffline && prevKey && state.channels[prevKey] &&
      !state.channels[prevKey].live) {
    for (var j = 0; j < state.sideItems.length; j++) {
      if (state.sideItems[j].type === 'offline-group') { idx = j; break; }
    }
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
  if (item.type === 'offline-group') {
    state.offlineExpanded = !state.offlineExpanded;
    renderSidebar('offline-group');
    resetIdle();
  } else if (item.type === 'add') openAdd();
  else switchTo(item.slug);
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
  if (!state.sidebarOpen) openSidebar();     // show the list right away, with the spinner turning
  var btn = document.getElementById('side-refresh');
  btn.classList.add('spinning');            // keep 'hidden' under renderSidebar's control
  var done = false, minned = false;
  function stop() { if (done && minned) btn.classList.remove('spinning'); }
  setTimeout(function () { minned = true; stop(); }, 700); // keep it spinning for at least one full turn
  fetchFavorites(function () {
    if (state.sidebarOpen) renderSidebar(); else openSidebar();
    if (!state.current && !state.vod) showNothing();
    done = true; stop();
  });
}

/* Add channel dialog */
// The Add dialog is a search: type a name, get matching channels, pick one. It
// still handles an exact slug or a kick.com URL as a fallback when search finds
// nothing. 'input' zone = typing; 'list' zone = choosing a result.
var add = { results: [], focus: -1, zone: 'input', session: 0 };
function openAdd() {
  setMode('add');
  add.session++;                    // ties in-flight adds to the dialog that started them
  add.results = []; add.focus = -1; add.zone = 'input';
  document.getElementById('addresults').innerHTML = '';
  document.getElementById('addmodal').className = '';
  var input = document.getElementById('addinput');
  input.value = '';
  setTimeout(function () { input.focus(); }, 50);
}
function closeAdd() {
  document.getElementById('addmodal').className = 'hidden';
  document.getElementById('addinput').blur();
  document.getElementById('addresults').innerHTML = '';
  add.results = []; add.zone = 'input';
  setMode('player');
  // Focus the playing channel (or the top of the list) — NOT the Add row, which would
  // yank the list all the way to the bottom every time the dialog is dismissed.
  var back = (state.current && state.order.indexOf(state.current) !== -1) ? state.current
           : (state.tempChannel || state.order[0] || 'add');
  if (state.sidebarOpen) renderSidebar(back); else openSidebar();
  if (!state.current) showNothing();   // bring back the idle message we hid
}
// OK: add the highlighted suggestion if you moved into the list, otherwise add
// exactly what was typed (the Add button does the same).
function confirmAdd() {
  if (add.zone === 'list') { selectAddResult(); return; }
  var q = document.getElementById('addinput').value.trim();
  if (q) addChannelBySlug(q); else closeAdd();
}
// Search as you type (debounced), showing channel suggestions live.
var addSearchTimer = null;
function scheduleLiveSearch() { clearTimeout(addSearchTimer); addSearchTimer = setTimeout(liveSearch, 300); }
function liveSearch() {
  var q = document.getElementById('addinput').value.trim();
  if (q.length < 2) { add.results = []; add.focus = -1; document.getElementById('addresults').innerHTML = ''; return; }
  serviceGet('/api/search?searched_word=' + encodeURIComponent(q), function (err, data) {
    if (state.mode !== 'add') return;
    if (document.getElementById('addinput').value.trim() !== q) return;   // a newer keystroke superseded this
    var chans = (!err && data && data.channels) ? data.channels : [];
    add.results = chans.slice(0, 30);
    if (add.zone === 'input') add.focus = -1;
    else if (!add.results.length) { backToInput(); return; }        // list emptied under us
    else if (add.focus >= add.results.length) add.focus = add.results.length - 1;
    renderAddResults();
  });
}
function enterAddList() {
  if (!add.results.length) return;
  add.zone = 'list'; add.focus = 0;
  document.getElementById('addinput').blur();
  applyAddFocus();
}
function renderAddResults() {
  var box = document.getElementById('addresults');
  box.innerHTML = '';
  add.results.forEach(function (c, i) {
    var name = (c.user && c.user.username) || c.slug;
    var already = getFavorites().indexOf(c.slug) !== -1;
    var row = document.createElement('div');
    row.setAttribute('data-base', 'aresult' + (already ? ' added' : ''));
    row.className = 'aresult' + (already ? ' added' : '');
    row.setAttribute('data-idx', i);
    var av = document.createElement('div');
    av.className = 'aav';
    av.textContent = (name || '?').charAt(0).toUpperCase();
    row.appendChild(av);
    var mid = document.createElement('div');
    mid.className = 'amid';
    mid.innerHTML = '<div class="aname"></div><div class="asub"></div>';
    mid.children[0].textContent = name;
    mid.children[1].textContent = fmtViewers(c.followers_count || c.followersCount || 0) + ' followers';
    row.appendChild(mid);
    if (c.isLive || c.is_live) {
      var live = document.createElement('span'); live.className = 'alive'; live.textContent = 'LIVE';
      row.appendChild(live);
    }
    if (already) {
      var ab = document.createElement('span'); ab.className = 'aadded'; ab.textContent = '✓ Added';
      row.appendChild(ab);
    }
    box.appendChild(row);
  });
  applyAddFocus();
}
function applyAddFocus() {
  var box = document.getElementById('addresults');
  for (var i = 0; i < box.children.length; i++) {
    var row = box.children[i];
    row.className = (row.getAttribute('data-base') || 'aresult') + (i === add.focus ? ' focused' : '');
    if (i === add.focus) {
      var top = row.offsetTop - box.offsetTop;
      if (top < box.scrollTop) box.scrollTop = top - 6;
      else if (top + row.offsetHeight > box.scrollTop + box.clientHeight)
        box.scrollTop = top + row.offsetHeight - box.clientHeight + 6;
    }
  }
}
function addNav(delta) {
  if (!add.results.length) return;
  var n = add.focus + delta;
  if (n < 0) { backToInput(); return; }   // up past the top jumps back to the box
  if (n >= add.results.length) return;
  add.focus = n; applyAddFocus();
}
function backToInput() {
  add.zone = 'input'; add.focus = -1;
  applyAddFocus();                 // keep the suggestions, just drop the highlight
  var input = document.getElementById('addinput');
  setTimeout(function () { input.focus(); }, 30);
}
function selectAddResult() {
  var c = add.results[add.focus];
  if (c) addChannelBySlug(c.slug);
}
function addChannelBySlug(raw) {
  var slug = (raw || '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?kick\.com\//, '').replace(/[\/?#].*$/, '');
  if (!slug) return;
  if (getFavorites().indexOf(slug) !== -1) {          // already following — don't add it again
    toast(((state.channels[slug] && state.channels[slug].name) || slug) + ' is already in your channels');
    return;
  }
  toast('Adding ' + slug + '...');
  var ses = add.session;
  apiGet(slug, function (err, data) {
    if (err) { toast(err === 404 ? 'No channel named "' + slug + '"' : 'Kick API unreachable'); return; }
    state.channels[slug] = normalize(slug, data);
    addFavorite(slug);
    toast('Added ' + state.channels[slug].name);
    var wasAdd = state.mode === 'add' && add.session === ses;   // never touch a newer dialog
    if (wasAdd) {                         // only touch the dialog if it is still the one on screen
      document.getElementById('addmodal').className = 'hidden';
      document.getElementById('addinput').blur();
      document.getElementById('addresults').innerHTML = '';
      add.results = []; add.zone = 'input';
      setMode('player');
    }
    fetchFavorites(function () {
      if (wasAdd && !state.sidebarOpen) openSidebar(); else if (state.sidebarOpen) renderSidebar(slug);
      if (!state.current && !state.vod && state.mode === 'player') showNothing();
    });
  });
}

/* Browse live streams (blue button) */
// Kick's directory has no language filter, so we pull the top live streams
// (sorted by viewers) and filter by language here on the TV.
var BROWSE_LANGS = [
  { label: 'All',      value: 'all' },
  { label: 'English',  value: 'English' },
  { label: 'Türkçe',   value: 'Turkish' },
  { label: 'Espanol',  value: 'Spanish' },
  { label: 'Portugues',value: 'Portuguese' },
  { label: 'Arabic',   value: 'Arabic' },
  { label: 'Deutsch',  value: 'German' },
  { label: 'Russian',  value: 'Russian' }
];
var BROWSE_COLS = 4;
var BROWSE_MAX_AUTO_PAGES = 12;   // ceiling for the automatic sparse-filter chain below
var browse = { open: false, langs: [], langIdx: 0, zone: 'grid', gridIdx: 0,
               raw: [], streams: [], page: 1, hasMore: true, fetching: false,
               category: null, categoryName: '', session: 0,
               sort: 'viewers', discover: false, renderLimit: 60 };
var BROWSE_SORTS = [
  { key: 'viewers', label: 'Top' },
  { key: 'newest',  label: 'New' },
  { key: 'small',   label: 'Small' }
];
function renderBrowseSort() {
  var el = document.getElementById('browse-sort');
  if (!el) return;
  for (var i = 0; i < BROWSE_SORTS.length; i++) {
    if (BROWSE_SORTS[i].key === browse.sort) { el.textContent = 'Sort: ' + BROWSE_SORTS[i].label; return; }
  }
}
function cycleBrowseSort() {
  var idx = 0;
  for (var i = 0; i < BROWSE_SORTS.length; i++) if (BROWSE_SORTS[i].key === browse.sort) { idx = i; break; }
  var next = BROWSE_SORTS[(idx + 1) % BROWSE_SORTS.length];
  browse.sort = next.key;
  browse.gridIdx = 0;
  browse.renderLimit = 60;
  renderBrowseSort();
  renderBrowse();
  toast('Sort: ' + (next.key === 'viewers' ? 'Most viewers' : (next.key === 'newest' ? 'Recently started' : 'Small streams first')));
}
/* "Discover only": hide channels you already follow — browsing is for finding
   new ones. The preference persists across opens. */
function loadBrowseDiscoverPref() {
  try { return localStorage.getItem('kicktv.browsediscover') === '1'; } catch (e) { return false; }
}
function renderBrowseDiscover() {
  var el = document.getElementById('browse-discover');
  if (el) el.className = browse.discover ? 'on' : '';
}
function toggleBrowseDiscover() {
  browse.discover = !browse.discover;
  try { localStorage.setItem('kicktv.browsediscover', browse.discover ? '1' : '0'); } catch (e) {}
  renderBrowseDiscover();
  browse.gridIdx = 0;
  browse.renderLimit = 60;
  renderBrowse();
  toast(browse.discover ? 'Hiding channels you follow' : 'Showing all channels');
}
// Skeleton cards shimmer in the grid while the first page loads.
function renderBrowseSkeletons() {
  var grid = document.getElementById('browse-grid');
  grid.innerHTML = '';
  for (var i = 0; i < 8; i++) {
    var sk = document.createElement('div');
    sk.className = 'bcard bskel';
    var th = document.createElement('div'); th.className = 'bthumb';
    sk.appendChild(th);
    var meta = document.createElement('div'); meta.className = 'bmeta';
    meta.innerHTML = '<div class="skline w1"></div><div class="skline w2"></div>';
    sk.appendChild(meta);
    grid.appendChild(sk);
  }
}

// Selected languages persist as a JSON array; an empty selection means All.
// Older installs stored a single string — migrate it on load.
function loadBrowseLangPref() {
  var v = null;
  try { v = localStorage.getItem('kicktv.browselang'); } catch (e) {}
  browse.langs = [];
  if (v && v.charAt(0) === '[') {
    try {
      var arr = JSON.parse(v);
      for (var i = 0; i < arr.length; i++) {
        for (var j = 1; j < BROWSE_LANGS.length; j++) {
          if (BROWSE_LANGS[j].value === arr[i]) { browse.langs.push(arr[i]); break; }
        }
      }
    } catch (e2) {}
  } else if (v && v !== 'all') {
    for (var k = 1; k < BROWSE_LANGS.length; k++) {
      if (BROWSE_LANGS[k].value === v) { browse.langs.push(v); break; }
    }
  }
  browse.langIdx = 0;
}
function saveBrowseLangPref() { try { localStorage.setItem('kicktv.browselang', JSON.stringify(browse.langs)); } catch (e) {} }
function setBrowseStatus(msg) { document.getElementById('browse-status').textContent = msg || ''; }
function thumbUrl(s) {
  var t = s && s.thumbnail;
  if (!t) return null;
  return t.src || t.url || (typeof t === 'string' ? t : null);
}
function openBrowse(categorySlug, categoryName) {
  if (!state.ready) return;
  browse.open = true;
  showCursor();
  closeSidebar();
  pausePlaybackForBrowse();
  document.getElementById('browse').className = '';
  loadBrowseLangPref();
  renderBrowseLangs();
  browse.zone = 'grid'; browse.gridIdx = 0;
  // optionally open pre-filtered (the clickable category in the top bar)
  browse.category = categorySlug || null;
  browse.categoryName = categorySlug ? (categoryName || '') : '';
  browse.session++;               // orphan any request still in flight from a previous opening
  browse.raw = []; browse.page = 1; browse.hasMore = true; browse.fetching = false;
  browse.renderLimit = 60;
  browse.sort = 'viewers';
  browse.discover = loadBrowseDiscoverPref();
  renderBrowseSort();
  renderBrowseDiscover();
  renderPinnedCatChips();
  renderBrowseSkeletons();
  updateBrowseTitle();
  loadBrowseMore(true);
}
// The title stays "Live now" — the highlighted Categories button and the
// selected chip already show which filter is active.
function updateBrowseTitle() {
  var btn = document.getElementById('browse-cats-btn');
  if (btn) btn.className = browse.category ? 'on' : '';
}
function closeBrowse() {
  browse.open = false;
  document.getElementById('browse').className = 'hidden';
  document.getElementById('browse-tip').className = 'hidden';
  resumePlaybackAfterBrowse();
}
// Fetch one page of the live directory and append it. `initial` chains a few
// pages on open to fill the grid; scrolling to the bottom pulls more.
// A card at the end of the grid with an indeterminate bar, shown while more
// pages are on their way. Re-renders wipe it; each fetch re-appends it.
function setBrowseLoadingCard(on) {
  var grid = document.getElementById('browse-grid');
  var card = document.getElementById('browse-loadcard');
  if (on) {
    if (!card) {
      card = document.createElement('div');
      card.id = 'browse-loadcard';
      card.className = 'bcard bloadcard';
      card.innerHTML = '<div class="loadtrack"><div class="loadfill"></div></div>';
    }
    grid.appendChild(card);          // (re)attach at the end
  } else if (card && card.parentNode) {
    card.parentNode.removeChild(card);
    if (browse.gridIdx >= browse.streams.length) {   // focus was parked on the card
      browse.gridIdx = Math.max(0, browse.streams.length - 1);
      applyBrowseFocus();
    }
  }
}
// The loading card counts as one focusable (but inert) cell at the end, so
// Down can reach it and the grid scrolls to reveal it.
function browseFocusCount() {
  var card = document.getElementById('browse-loadcard');
  return browse.streams.length + (card && card.parentNode ? 1 : 0);
}
// No page cap: the directory's own end (an empty page) is the terminator, the
// sparse auto-chain stops at a healthy grid, and closing Browse cancels via
// the session token.
function loadBrowseMore(initial) {
  if (browse.fetching || !browse.hasMore) return;
  browse.fetching = true;
  if (!browse.raw.length) setBrowseStatus('Loading...');
  else setBrowseLoadingCard(true);   // subsequent pages: progress card in the grid
  var pg = browse.page, ses = browse.session;
  serviceGet('/stream/livestreams/en?page=' + pg + '&limit=50&sort=desc', function (err, data) {
    if (ses !== browse.session) return;   // response belongs to a closed/reopened session
    browse.fetching = false;
    if (!browse.open) return;
    var arr = (!err && data && data.data) ? data.data : [];
    if (!arr.length) {
      browse.hasMore = false;
      setBrowseLoadingCard(false);
      if (!browse.raw.length) setBrowseStatus('Could not reach Kick'); else renderBrowse();
      return;
    }
    // Keep only the fields the app uses — deep scans can hold thousands of
    // these, and the full directory objects are ~10x bigger.
    for (var pi2 = 0; pi2 < arr.length; pi2++) {
      var it = arr[pi2], ch2 = it.channel || {}, cat0 = (it.categories && it.categories[0]) || null;
      arr[pi2] = {
        viewer_count: it.viewer_count || 0,
        language: it.language || '',
        session_title: it.session_title || '',
        created_at: it.created_at || '',
        thumbnail: it.thumbnail || null,
        categories: cat0 ? [{ name: cat0.name || '', slug: cat0.slug || '' }] : [],
        channel: { slug: ch2.slug || it.slug || '', user: { username: (ch2.user && ch2.user.username) || '' } }
      };
    }
    browse.raw = browse.raw.concat(arr);
    browse.page = pg + 1;
    // Beyond the rendered window a repaint per page is wasted work; every
    // third page keeps the chip counts and loading card fresh enough.
    if (browse.streams.length < browse.renderLimit || pg % 3 === 0) renderBrowse();
    // Chain more pages while filling. Filters (category, Discover, languages)
    // thin each page out, so keep pulling until the grid has a healthy count —
    // no more one-page-per-scroll crawling to find anything.
    // The sparse chain keeps pulling until the filtered grid looks healthy, but a
    // filter whose whole population is under 24 can never get there, so it needs a
    // hard ceiling or it walks the entire directory. hasMore stays true, so moving
    // or scrolling to the end still fetches more on demand — only the automatic
    // chain is bounded.
    var filtersActive = !!(browse.category || browse.discover || browse.langs.length);
    var sparse = filtersActive && browse.streams.length < 24 && browse.page <= BROWSE_MAX_AUTO_PAGES;
    if ((initial && browse.page <= (browse.category ? 8 : 3)) || sparse) loadBrowseMore(true);
    if (!browse.fetching) setBrowseLoadingCard(false);   // no follow-up came: done
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
  if (browse.langs.length) list = list.filter(function (s) { return browse.langs.indexOf(s.language) !== -1; });
  if (browse.discover) {
    var favsNow = getFavorites();
    list = list.filter(function (s) { return favsNow.indexOf((s.channel || {}).slug) === -1; });
  }
  if (browse.category) list = list.filter(function (s) {
    return s.categories && s.categories[0] && s.categories[0].slug === browse.category;
  });
  if (browse.sort === 'small') {
    list.sort(function (a, b) { return (a.viewer_count || 0) - (b.viewer_count || 0); });
  } else if (browse.sort === 'newest') {
    for (var pi = 0; pi < list.length; pi++) {
      if (list[pi].__startTs === undefined) list[pi].__startTs = parseKickTime(list[pi].created_at);
    }
    list.sort(function (a, b) { return (b.__startTs || 0) - (a.__startTs || 0); });
  } else {
    list.sort(function (a, b) { return (b.viewer_count || 0) - (a.viewer_count || 0); });
  }
  browse.streams = list;

  // Windowed rendering: only the first renderLimit cards live in the DOM. The
  // window grows as focus or scrolling nears its end, so deep scans stay cheap
  // no matter how many streams are loaded behind it.
  if (browse.gridIdx >= browse.renderLimit) browse.renderLimit = browse.gridIdx + 40;
  var grid = document.getElementById('browse-grid');
  var savedScroll = grid.scrollTop;
  grid.innerHTML = '';
  browse.streams.slice(0, browse.renderLimit).forEach(function (s, i) {
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
      (browse.category ? 'No ' + browse.categoryName + ' streams in the top live list' :
       (!browse.langs.length ? 'Nothing live right now' : 'No live channels in these languages yet')));
  } else setBrowseStatus('');

  if (browse.gridIdx >= browse.streams.length) browse.gridIdx = Math.max(0, browse.streams.length - 1);
  renderPinnedCatChips();          // keep the per-category live counts current
  applyBrowseFocus();
}
function applyBrowseFocus() {
  var langsEl = document.getElementById('browse-langs');
  for (var i = 0; i < langsEl.children.length; i++) {
    var chip = langsEl.children[i];
    chip.className = 'blang' +
      ((i === 0 ? !browse.langs.length : browse.langs.indexOf(BROWSE_LANGS[i].value) !== -1) ? ' sel' : '') +
      (browse.zone === 'lang' && i === browse.langIdx ? ' focused' : '');
  }
  var grid = document.getElementById('browse-grid');
  for (var j = 0; j < grid.children.length; j++) {
    var focusedCls = (browse.zone === 'grid' && j === browse.gridIdx) ? ' focused' : '';
    if (grid.children[j].id === 'browse-loadcard') {
      grid.children[j].className = 'bcard bloadcard' + focusedCls;   // focusable, not activatable
    } else {
      grid.children[j].className = 'bcard' + focusedCls;
    }
  }
  if (browse.zone === 'grid' && grid.children[browse.gridIdx]) {
    var el = grid.children[browse.gridIdx];
    var top = el.offsetTop - grid.offsetTop;
    if (top < grid.scrollTop) grid.scrollTop = top - 12;
    else if (top + el.offsetHeight > grid.scrollTop + grid.clientHeight)
      grid.scrollTop = top + el.offsetHeight - grid.clientHeight + 12;
  }
  scheduleBrowsePeek();
}
// After dwelling on a browse card, refresh its thumbnail with the channel's
// current frame (the directory image can be minutes old).
var browsePeekTimer = null;
function scheduleBrowsePeek() {
  clearTimeout(browsePeekTimer);
  if (!browse.open || browse.zone !== 'grid') return;
  var idx = browse.gridIdx;
  var s = browse.streams[idx];
  var slug = s && s.channel && s.channel.slug;
  if (!slug) return;
  browsePeekTimer = setTimeout(function () {
    if (!browse.open || browse.gridIdx !== idx) return;
    function apply(url) {
      if (!browse.open || browse.gridIdx !== idx) return;
      var grid = document.getElementById('browse-grid');
      var card = grid.children[idx];
      var th = card && card.querySelector('.bthumb');
      if (th) th.style.backgroundImage = 'url(' + url + ')';
    }
    var cached = previewCache[slug];
    if (cached && Date.now() - cached.t < 60000) { apply(cached.url); return; }
    fetchPreviewUrl(slug, function () {
      var c2 = previewCache[slug];
      if (c2) apply(c2.url);
    });
  }, 800);
}
// Toggle a language chip in or out of the selection. The All chip (index 0)
// clears the selection. Multiple languages can be active at once.
function toggleBrowseLang(idx) {
  browse.langIdx = idx;
  if (idx === 0) browse.langs = [];
  else {
    var v = BROWSE_LANGS[idx].value;
    var i = browse.langs.indexOf(v);
    if (i === -1) browse.langs.push(v); else browse.langs.splice(i, 1);
  }
  saveBrowseLangPref();
  browse.gridIdx = 0;
  browse.renderLimit = 60;
  renderBrowse();            // just re-filter what we already fetched
}
function browseMove(dx, dy) {
  if (browse.zone === 'lang') {
    if (dy === 1) { browse.zone = 'grid'; browse.gridIdx = 0; applyBrowseFocus(); return; }
    if (dx !== 0) {
      var n = browse.langIdx + dx;
      if (n >= 0 && n < BROWSE_LANGS.length) { browse.langIdx = n; applyBrowseFocus(); }  // move focus only; OK toggles
    }
    return;
  }
  var count = browseFocusCount();
  if (dy === -1 && browse.gridIdx < BROWSE_COLS) { browse.zone = 'lang'; applyBrowseFocus(); return; }
  if (!count) return;
  var idx = browse.gridIdx;
  if (dx === 1 && idx < count - 1) idx++;
  else if (dx === -1 && idx > 0) idx--;
  else if (dy === 1 && idx + BROWSE_COLS < count) idx += BROWSE_COLS;
  else if (dy === 1 && Math.floor(idx / BROWSE_COLS) < Math.floor((count - 1) / BROWSE_COLS)) idx = count - 1;  // partial last row
  else if (dy === -1 && idx - BROWSE_COLS >= 0) idx -= BROWSE_COLS;
  else if (dy === 1 || dx === 1) loadBrowseMore(false);
  browse.gridIdx = idx;
  if (idx >= browse.renderLimit - 2 * BROWSE_COLS && browse.renderLimit < browse.streams.length) {
    browse.renderLimit += 40;          // extend the window before focus hits its edge
    renderBrowse();
  }
  applyBrowseFocus();
  // pull the next page as soon as focus reaches the last couple of rows
  if (browse.gridIdx >= browse.streams.length - 2 * BROWSE_COLS) loadBrowseMore(false);
}
function browseActivate() {
  if (browse.zone === 'lang') { toggleBrowseLang(browse.langIdx); return; }  // OK toggles the chip; Down enters the grid
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

/* Categories popup. Browse Kick's categories (sorted by viewers) and filter the
   live grid to one. Kick has no per-category live-streams endpoint, so the filter
   is applied over the streams already pulled into Browse: great for popular
   categories, thinner for niche ones. Opened from the Browse header. */
var cats = { open: false, gridIdx: 0, list: [], page: 1, hasMore: true, fetching: false, session: 0,
             query: '', results: null };
// The grid shows either the paginated list or, while searching, the API's
// category search results (identical item shape).
function displayedCats() { return cats.results || cats.list; }
var CATS_COLS = 4;
function setCatsStatus(msg) { document.getElementById('cats-status').textContent = msg || ''; }
function catBanner(c) {
  var b = c && c.banner;
  if (!b) return null;
  return b.url || b.src || b.responsive || (typeof b === 'string' ? b : null);
}
function openCats() {
  if (!browse.open) return;
  cats.open = true; cats.session++; cats.gridIdx = 0; cats.list = []; cats.page = 1; cats.hasMore = true; cats.fetching = false;
  cats.query = ''; cats.results = null;
  document.getElementById('cats-search').value = '';
  showCursor();
  document.getElementById('cats').className = '';
  renderCatsSkeletons();
  setCatsStatus('Loading...');
  loadCatsMore(true);
}
function closeCats() {
  cats.open = false;
  hideTip();
  try { document.getElementById('cats-search').blur(); } catch (e) {}
  document.getElementById('cats').className = 'hidden';
}
// Skeleton tiles shimmer while the first page loads.
function renderCatsSkeletons() {
  var grid = document.getElementById('cats-grid');
  grid.innerHTML = '';
  for (var i = 0; i < 8; i++) {
    var sk = document.createElement('div');
    sk.className = 'ccard cskel';
    var b = document.createElement('div'); b.className = 'cbanner';
    sk.appendChild(b);
    grid.appendChild(sk);
  }
}
// No page cap here either: the list's own end is the terminator.
function loadCatsMore(initial) {
  if (cats.fetching || !cats.hasMore) return;
  cats.fetching = true;
  var pg = cats.page, ses = cats.session;
  serviceGet('/api/v1/subcategories?page=' + pg + '&limit=32', function (err, data) {
    if (ses !== cats.session) return;     // stale response from a previous opening
    cats.fetching = false;
    if (!cats.open) return;
    var arr = (!err && data && data.data) ? data.data : [];
    if (!arr.length) { cats.hasMore = false; if (!cats.list.length && !cats.results) setCatsStatus('Could not load categories'); return; }
    cats.list = cats.list.concat(arr);
    cats.page = pg + 1;
    if (!cats.results) {                 // do not repaint over active search results
      renderCats();
      setCatsStatus('');
    }
    if (initial && cats.page <= 2) loadCatsMore(true);
  });
}
// Search across all of Kick's categories (the paginated list only holds what
// has been scrolled in so far).
var catsSearchTimer = null;
function runCatsSearch(q) {
  var ses = cats.session;
  serviceGet('/api/search?searched_word=' + encodeURIComponent(q), function (err, data) {
    if (ses !== cats.session || !cats.open || cats.query !== q) return;   // superseded
    var arr = (!err && data && Object.prototype.toString.call(data.categories) === '[object Array]')
      ? data.categories : [];
    cats.results = arr;
    cats.gridIdx = 0;
    renderCats();
    setCatsStatus(arr.length ? '' : 'No categories match');
  });
}
function renderCats() {
  var grid = document.getElementById('cats-grid');
  var saved = grid.scrollTop;
  grid.innerHTML = '';
  var allTile = document.createElement('div');   // index 0 clears the filter
  allTile.className = 'ccard'; allTile.setAttribute('data-idx', '-1');
  allTile.innerHTML = '<div class="cbanner"></div><div class="cname">All categories</div>';
  grid.appendChild(allTile);
  displayedCats().forEach(function (c, i) {
    var card = document.createElement('div');
    card.className = 'ccard';
    card.setAttribute('data-idx', i);
    var banner = document.createElement('div');
    banner.className = 'cbanner';
    var url = catBanner(c);
    if (url) banner.style.backgroundImage = 'url(' + url + ')';
    var vw = document.createElement('span');
    vw.className = 'cviewers';
    vw.innerHTML = '<span class="bdot"></span>';
    vw.appendChild(document.createTextNode(fmtViewers(c.viewers || 0)));
    banner.appendChild(vw);
    var pin = document.createElement('span');
    pin.className = 'catpin' + (isCatPinned(c.slug) ? ' on' : '');
    pin.setAttribute('data-act', 'catpin');
    pin.setAttribute('title', 'Pin category');
    pin.innerHTML = pinIcon();
    banner.appendChild(pin);
    var block = document.createElement('span');
    block.className = 'catblock' + (isCatBlocked(c.slug) ? ' on' : '');
    block.setAttribute('data-act', 'catblock');
    block.setAttribute('title', 'Block category');
    block.innerHTML = blockIcon();
    banner.appendChild(block);
    var name = document.createElement('div');
    name.className = 'cname';
    name.textContent = c.name || c.slug;
    card.appendChild(banner); card.appendChild(name);
    grid.appendChild(card);
  });
  grid.scrollTop = saved;
  if (cats.gridIdx >= grid.children.length) cats.gridIdx = grid.children.length - 1;
  applyCatsFocus();
}
function applyCatsFocus() {
  var grid = document.getElementById('cats-grid');
  for (var j = 0; j < grid.children.length; j++) {
    grid.children[j].className = 'ccard' + (j === cats.gridIdx ? ' focused' : '');
  }
  var el = grid.children[cats.gridIdx];
  if (el) {
    var top = el.offsetTop - grid.offsetTop;
    if (top < grid.scrollTop) grid.scrollTop = top - 12;
    else if (top + el.offsetHeight > grid.scrollTop + grid.clientHeight)
      grid.scrollTop = top + el.offsetHeight - grid.clientHeight + 12;
  }
}
function catsMove(dx, dy) {
  var n = document.getElementById('cats-grid').children.length;
  if (!n) return;
  var idx = cats.gridIdx;
  if (dx === 1 && idx < n - 1) idx++;
  else if (dx === -1 && idx > 0) idx--;
  else if (dy === 1 && idx + CATS_COLS < n) idx += CATS_COLS;
  else if (dy === 1 && Math.floor(idx / CATS_COLS) < Math.floor((n - 1) / CATS_COLS)) idx = n - 1;  // partial last row
  else if (dy === -1 && idx - CATS_COLS >= 0) idx -= CATS_COLS;
  cats.gridIdx = idx;
  applyCatsFocus();
  if (!cats.results && cats.gridIdx >= (cats.list.length + 1) - 2 * CATS_COLS) loadCatsMore(false);
}
function catsActivate() {
  if (cats.gridIdx === 0) { selectCategory(null, ''); return; }   // the All tile
  var c = displayedCats()[cats.gridIdx - 1];
  if (c) selectCategory(c.slug, c.name || c.slug);
}
function selectCategory(slug, name) {
  browse.category = slug || null;
  browse.categoryName = name || '';
  browse.gridIdx = 0;
  browse.renderLimit = 60;
  closeCats();
  updateBrowseTitle();
  renderPinnedCatChips();
  renderBrowse();
  if (slug) loadBrowseMore(true);   // pull more pages to better fill the filtered grid
}

/* Pinned categories: starred in the Categories popup (Green, or the pin icon),
   they appear as quick chips above the Browse grid. */
function getPinnedCats() {
  try {
    var v = JSON.parse(localStorage.getItem('kicktv.pinnedcats'));
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  } catch (e) { return []; }
}
function savePinnedCats(list) { try { localStorage.setItem('kicktv.pinnedcats', JSON.stringify(list)); } catch (e) {} }
function isCatPinned(slug) {
  var l = getPinnedCats();
  for (var i = 0; i < l.length; i++) if (l[i].slug === slug) return true;
  return false;
}
function toggleCatPin(slug, name) {
  if (!slug) return;
  var l = getPinnedCats(), out = [], found = false;
  for (var i = 0; i < l.length; i++) { if (l[i].slug === slug) found = true; else out.push(l[i]); }
  if (!found) { out.push({ slug: slug, name: name || slug }); while (out.length > 8) out.shift(); }
  savePinnedCats(out);
  toast(found ? ('Unpinned ' + (name || slug)) : ('Pinned ' + (name || slug)));
  renderPinnedCatChips();
  if (cats.open) renderCats();
}
function renderPinnedCatChips() {
  var box = document.getElementById('browse-pinnedcats');
  var panel = document.getElementById('browse-panel');
  if (!box) return;
  box.innerHTML = '';
  var l = getPinnedCats();
  if (!l.length) {
    box.className = 'hidden';
    if (panel) panel.className = '';
    return;
  }
  box.className = '';
  if (panel) panel.className = 'haspins';   // the grid gives up a row of height
  // Live streams per category, counted under the SAME language and Discover
  // filters the grid uses — the number a chip shows is the number of cards
  // clicking it will yield. Re-rendered on every filter change.
  var counts = {};
  var pool = browse.raw || [];
  var favsNow = browse.discover ? getFavorites() : null;
  for (var ri = 0; ri < pool.length; ri++) {
    var s = pool[ri];
    if (browse.langs.length && browse.langs.indexOf(s.language) === -1) continue;
    if (favsNow && favsNow.indexOf((s.channel || {}).slug) !== -1) continue;
    var rc = s.categories && s.categories[0];
    if (rc && rc.slug) counts[rc.slug] = (counts[rc.slug] || 0) + 1;
  }
  var all = document.createElement('span');
  all.className = 'pcat' + (browse.category ? '' : ' sel');
  all.textContent = 'All';
  all.setAttribute('data-cslug', '');
  box.appendChild(all);
  for (var i = 0; i < l.length; i++) {
    var chip = document.createElement('span');
    chip.className = 'pcat' + (browse.category === l[i].slug ? ' sel' : '');
    chip.setAttribute('data-cslug', l[i].slug);
    chip.setAttribute('data-cname', l[i].name);
    chip.appendChild(document.createTextNode(l[i].name + (counts[l[i].slug] ? ' · ' + counts[l[i].slug] : '')));
    var x = document.createElement('span');   // quick unpin without opening Categories
    x.className = 'pcatx';
    x.setAttribute('data-x', '1');
    x.setAttribute('title', 'Unpin');
    x.textContent = '✕';
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

/* Blocked categories. A category you would rather not see: followed channels
   streaming in one stay in your list but sink to the bottom of the live group,
   greyed out, and stop raising alerts or being picked automatically. */
var BLOCKEDCATS_KEY = 'kicktv.blockedcats';
var BLOCKEDCATS_LIMIT = 32;   // only ever shown in a scrollable popup, unlike the 8 pinned chips
// sortOrder asks this hundreds of times per pass, so the parsed list is kept
// around. saveBlockedCats is the only writer, which is the whole invalidation
// story. Callers must treat the returned array as read-only.
var blockedCatsMemo = null;
function getBlockedCats() {
  if (blockedCatsMemo) return blockedCatsMemo;
  var v = null;
  try { v = JSON.parse(localStorage.getItem(BLOCKEDCATS_KEY)); } catch (e) {}
  blockedCatsMemo = Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  return blockedCatsMemo;
}
function saveBlockedCats(list) {
  blockedCatsMemo = null;
  try { localStorage.setItem(BLOCKEDCATS_KEY, JSON.stringify(list)); } catch (e) {}
}
function isCatBlocked(slug) {
  if (!slug) return false;
  var l = getBlockedCats();
  for (var i = 0; i < l.length; i++) if (l[i].slug === slug) return true;
  return false;
}
// Only ever true for a live channel: an offline record carries an empty
// categorySlug, so blocking simply does not apply to it.
function isChannelBlocked(c) {
  return !!(c && c.live && c.categorySlug && isCatBlocked(c.categorySlug));
}
// Store only — callers handle the toast and the re-render.
function toggleCatBlock(slug, name) {
  if (!slug) return false;
  var l = getBlockedCats(), out = [], found = false, i;
  for (i = 0; i < l.length; i++) { if (l[i].slug === slug) found = true; else out.push(l[i]); }
  if (!found) {
    out.push({ slug: slug, name: name || slug });
    while (out.length > BLOCKEDCATS_LIMIT) out.shift();
  }
  saveBlockedCats(out);
  // Pinned and blocked contradict each other. Drop the pin directly rather than
  // through toggleCatPin, which would toast and re-render on its own.
  if (!found && isCatPinned(slug)) {
    var p = getPinnedCats(), keep = [];
    for (i = 0; i < p.length; i++) if (p[i].slug !== slug) keep.push(p[i]);
    savePinnedCats(keep);
  }
  return !found;
}
// Everything that has to catch up once the blocked set changes. Re-sorting is
// what moves a channel into or out of the demoted tier.
function applyBlockedChange() {
  sortOrder(state.order.slice());
  if (state.sidebarOpen) renderSidebar();
  if (chpop.open) refreshChpopList();
  renderPinnedCatChips();          // blocking may have removed a pin
  if (cats.open) renderCats();
  if (settings.open) renderSettings();
}

/* Past videos (VOD) popup and playback.
   Opens from clicking an offline channel or the Yellow button. Lists a channel's
   past videos; picking one plays it. VOD playback is kept separate from live
   playback: no channel refetch, no live-token recovery, and no stall watchdog,
   because a video on demand can pause to buffer without anything being wrong. */
var LAST_VOD_KEY = 'kicktv.lastvod';
var VOD_PROGRESS_KEY = 'kicktv.vodprogress';
var VOD_PROGRESS_LIMIT = 100;
var vodProgressLastWrite = 0;
// Keep only a stable recording identity for startup recovery. Playback URLs
// expire, so boot always resolves this identity against a fresh videos list.
function vodStableId(v) {
  var nested = v && v.video;
  var id = null;
  if (nested && nested.uuid != null && nested.uuid !== '') id = nested.uuid;
  else if (nested && nested.id != null && nested.id !== '') id = nested.id;
  else if (v && v.uuid != null && v.uuid !== '') id = v.uuid;
  else if (v && v.id != null && v.id !== '') id = v.id;
  return id == null ? null : String(id);
}
function clearLastVod() {
  try { localStorage.removeItem(LAST_VOD_KEY); } catch (e) {}
}
function loadLastVod() {
  try {
    var marker = JSON.parse(localStorage.getItem(LAST_VOD_KEY));
    if (marker && marker.version === 1 && typeof marker.slug === 'string' &&
        marker.slug && typeof marker.id === 'string' && marker.id) return marker;
  } catch (e) {}
  clearLastVod();
  return null;
}
function saveLastVod(slug, v, name) {
  var id = vodStableId(v);
  if (!slug || !id) { clearLastVod(); return; }
  try {
    localStorage.setItem(LAST_VOD_KEY, JSON.stringify({
      version: 1,
      slug: String(slug),
      id: id,
      name: name || String(slug),
      updated: Date.now()
    }));
  } catch (e) {}
}
function clearLastVodMatch(slug, id) {
  var marker = loadLastVod();
  if (marker && marker.slug === slug && (!id || marker.id === String(id))) clearLastVod();
}
function loadVodProgress() {
  try {
    var data = JSON.parse(localStorage.getItem(VOD_PROGRESS_KEY));
    if (data && data.version === 1 && data.items && typeof data.items === 'object') return data;
  } catch (e) {}
  return { version: 1, items: {} };
}
function writeVodProgress(data) {
  try {
    var keys = Object.keys(data.items);
    if (keys.length > VOD_PROGRESS_LIMIT) {
      keys.sort(function (a, b) {
        return (data.items[a].updated || 0) - (data.items[b].updated || 0);
      });
      while (keys.length > VOD_PROGRESS_LIMIT) delete data.items[keys.shift()];
    }
    localStorage.setItem(VOD_PROGRESS_KEY, JSON.stringify(data));
  } catch (e) {}
}
function vodProgressKey(slug, v) {
  var id = vodStableId(v);
  if (!id && v && (v.created_at || v.duration)) {
    id = String(v.created_at || '') + '|' + String(v.duration || '');
  }
  return slug + ':' + String(id || (v && v.source) || 'unknown');
}
function savedVodPosition(key) {
  var entry = loadVodProgress().items[key];
  var pos = entry && parseFloat(entry.position);
  return isFinite(pos) && pos >= 10 ? pos : 0;
}
function clearVodProgress(key) {
  if (!key) return;
  var data = loadVodProgress();
  if (data.items[key]) {
    delete data.items[key];
    writeVodProgress(data);
  }
}

/* Live marks. Where you were in a live stream when you stopped watching, held
   until the recording of that session turns up in Past videos. Nothing is shown
   while the stream is still running — this is purely a note to self. */
var LIVEMARK_KEY = 'kicktv.livemarks';
var LIVEMARK_LIMIT = 20;
var LIVEMARK_TTL_MS = 14 * 24 * 3600 * 1000;   // a recording that never appears fades away
var LIVEMARK_MIN_WATCH_MS = 60000;             // ignore a stream you only glanced at
function loadLiveMarks() {
  try {
    var data = JSON.parse(localStorage.getItem(LIVEMARK_KEY));
    if (data && data.version === 1 && data.items && typeof data.items === 'object') return data;
  } catch (e) {}
  return { version: 1, items: {} };
}
function writeLiveMarks(data) {
  try {
    var keys = Object.keys(data.items);
    if (keys.length > LIVEMARK_LIMIT) {
      keys.sort(function (a, b) {
        return (data.items[a].updated || 0) - (data.items[b].updated || 0);
      });
      while (keys.length > LIVEMARK_LIMIT) delete data.items[keys.shift()];
    }
    localStorage.setItem(LIVEMARK_KEY, JSON.stringify(data));
  } catch (e) {}
}
function clearLiveMark(slug) {
  var data = loadLiveMarks();
  if (data.items[slug]) { delete data.items[slug]; writeLiveMarks(data); }
}
var LIVEMARK_MATCH_TOLERANCE_MS = 600000;   // 10 min of slack between session and recording
var LIVEMARK_DURATION_GRACE_SEC = 120;      // a recording can stop a little short of the stream
// Kick reports recording length in milliseconds.
function vodDurationMs(v) { return (v && v.duration) || 0; }
// The recording's real start. The mark was taken WHILE the stream ran, so a
// created_at later than that capture cannot be a start — it is a record time,
// and the true start is that minus the recording's length. This is what lets the
// match work whichever way Kick means the field.
function vodStartMs(v, leftAtMs) {
  var raw = parseKickTime(v && v.created_at);
  if (!raw) return 0;
  return raw <= leftAtMs ? raw : raw - vodDurationMs(v);
}
// Does this recording's span actually cover the moment the viewer left? Used as
// the fallback: it is the difference between "probably the same session" and
// "the only thing left in the list", which may be an unrelated later stream.
function vodCoversMark(v, mark) {
  var st = vodStartMs(v, mark.leftAtMs);
  if (!st) return false;
  return mark.leftAtMs >= st && mark.leftAtMs <= st + vodDurationMs(v);
}
// Pick the recording of the session this mark came from.
// Verified against the live API on 2026-07-25: a video item's created_at is the
// stream start and matches the channel's startedAt exactly, so the primary match
// is effectively an equality test and the tolerance is just slack.
function matchVodForMark(mark, list) {
  var sessionMs = parseKickTime(mark && mark.sessionStartedAt);
  if (!sessionMs || !list || !list.length) return null;
  var i, candidates = [], hits = [];
  for (i = 0; i < list.length; i++) {
    // The stream still running is in this list too, with is_live set and a
    // duration of 0. It is not a finished recording.
    if (list[i].is_live) continue;
    // You cannot have left 90 minutes into a 40 minute recording.
    if (vodDurationMs(list[i]) / 1000 >= mark.offsetSec - LIVEMARK_DURATION_GRACE_SEC) {
      candidates.push(list[i]);
    }
  }
  for (i = 0; i < candidates.length; i++) {
    var st = vodStartMs(candidates[i], mark.leftAtMs);
    if (st && Math.abs(st - sessionMs) <= LIVEMARK_MATCH_TOLERANCE_MS) hits.push(candidates[i]);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {                     // same start: let the title decide
    for (i = 0; i < hits.length; i++) {
      if (mark.title && hits[i].session_title === mark.title) return hits[i];
    }
    return hits[0];
  }
  // The start did not line up. Only accept a lone candidate whose span actually
  // contains the moment we left — Kick prunes old recordings, so "the only one
  // left" can easily be a different stream entirely.
  if (candidates.length === 1 && vodCoversMark(candidates[0], mark)) return candidates[0];
  return null;
}
// Where in the recording the viewer actually was. Measured against the
// recording's own timeline, so one that starts a little after the stream went
// live still lands in the right place.
function positionForMark(mark, v) {
  var startMs = vodStartMs(v, mark.leftAtMs);
  if (!startMs) return 0;
  var durSec = vodDurationMs(v) / 1000;
  if (!(durSec > 0)) return 0;
  var offset = (mark.leftAtMs - startMs) / 1000;
  // Stop a second short of the 0.9 mark that counts as watched, so a seeded
  // position can never make a recording you barely saw look finished.
  var maxPos = durSec * 0.9 - 1;
  if (offset > maxPos) offset = maxPos;
  return offset > 0 ? Math.floor(offset) : 0;
}
// Past videos just opened. If the marked session has ended and its recording is
// in this list, seed that recording's resume point and retire the mark. Progress
// the viewer built by actually watching always wins.
function resolveLiveMark(slug, list) {
  var marks = loadLiveMarks();
  var mark = marks.items[slug];
  if (!mark) return false;
  var now = Date.now();
  if (now - (mark.updated || 0) > LIVEMARK_TTL_MS) { clearLiveMark(slug); return false; }
  // Compare the session, not just the live flag: the channel may be live again
  // with a new stream, which means the marked one is over.
  var c = state.channels[slug];
  if (c && c.live && c.startedAt === mark.sessionStartedAt) return false;
  var matched = matchVodForMark(mark, list);
  if (!matched) return false;                      // maybe next time; it expires eventually
  var key = vodProgressKey(slug, matched);
  var progress = loadVodProgress();
  if (progress.items[key]) { clearLiveMark(slug); return false; }   // never rewind
  var pos = positionForMark(mark, matched);
  if (!(pos >= 10)) { clearLiveMark(slug); return false; }          // nothing worth resuming
  progress.items[key] = {
    position: pos,
    duration: Math.floor(vodDurationMs(matched) / 1000),
    updated: now,
    name: mark.name,
    title: mark.title
  };
  writeVodProgress(progress);
  clearLiveMark(slug);
  return true;
}
var liveWatchStartedMs = 0;   // when the current live playback began
var liveMarkLastWrite = 0;
// Quietly remember where the viewer is in the live stream, so the recording of
// this session can pick up there once it ends. Nothing is shown for this.
function saveLiveMark(force) {
  var slug = state.current;
  if (!slug || state.vod) return;
  var c = state.channels[slug];
  if (!c || !c.live || !c.startedAt) return;
  var now = Date.now();
  // Tuning in for a few seconds should not plant a mark hours deep.
  if (!liveWatchStartedMs || now - liveWatchStartedMs < LIVEMARK_MIN_WATCH_MS) return;
  if (!force && now - liveMarkLastWrite < 5000) return;
  var startedMs = parseKickTime(c.startedAt);
  if (!startedMs) return;
  var offsetSec = Math.floor((now - startedMs) / 1000);
  if (!(offsetSec >= 10)) return;
  liveMarkLastWrite = now;
  var data = loadLiveMarks();
  data.items[slug] = {
    sessionStartedAt: c.startedAt,
    leftAtMs: now,
    offsetSec: offsetSec,
    name: c.name || slug,
    title: c.title || '',
    updated: now
  };
  writeLiveMarks(data);
}

function saveVodProgress(force) {
  if (!state.vod || !state.vod.key) return;
  // Ignore media events left over from the previous source until this VOD has
  // its own metadata. Otherwise a queued pause/timeupdate at 0 can erase the
  // new video's saved resume point during a source switch.
  if (!state.vod.progressReady ||
      (state.vod.resumeAt > 0 && !state.vod.resumeApplied)) return;
  var now = Date.now();
  if (!force && now - vodProgressLastWrite < 5000) return;
  vodProgressLastWrite = now;
  if (state.vod.completed) return;   // completeVodProgress already wrote the final watched entry
  var video = document.getElementById('video');
  var pos = parseFloat(video.currentTime), dur = parseFloat(video.duration);
  if (!isFinite(pos) || pos < 0) return;
  var data = loadVodProgress();
  var prev = data.items[state.vod.key];
  // Watched is sticky, YouTube-style: crossing 90% marks it, and rewinding
  // afterwards does not unmark it.
  var watched = !!(prev && prev.watched);
  if (isFinite(dur) && dur > 0 && pos / dur >= 0.9) watched = true;
  if (pos < 10) {
    // nothing to resume this close to the start, but keep the watched mark alive
    if (watched) {
      data.items[state.vod.key] = {
        position: 0,
        duration: isFinite(dur) && dur > 0 ? Math.floor(dur) : ((prev && prev.duration) || 0),
        updated: now,
        watched: true
      };
    } else delete data.items[state.vod.key];
  } else {
    data.items[state.vod.key] = {
      position: Math.floor(pos),
      duration: isFinite(dur) && dur > 0 ? Math.floor(dur) : 0,
      updated: now,
      name: state.vod.name,        // lets the home screen label resumable videos
      title: state.vod.title
    };
    if (watched) data.items[state.vod.key].watched = true;
  }
  writeVodProgress(data);
}
function applyVodResume() {
  if (!state.vod) return;
  var video = document.getElementById('video');
  if (video.readyState < 1) return;
  state.vod.progressReady = true;
  if (state.vod.resumeApplied) return;
  if (!(state.vod.resumeAt > 0)) { state.vod.resumeApplied = true; return; }
  var pos = state.vod.resumeAt;
  if (isFinite(video.duration) && video.duration > 0) pos = Math.min(pos, Math.max(0, video.duration - 1));
  if (!(pos >= 10)) { state.vod.resumeApplied = true; return; }
  try {
    video.currentTime = pos;
    state.vod.resumeApplied = true;
  } catch (e) {}
}
function completeVodProgress() {
  if (!state.vod) return;
  state.vod.completed = true;
  // Finished: no resume point (a rewatch starts from the beginning), but the
  // recording stays marked as watched for the Past videos grid.
  var video = document.getElementById('video');
  var dur = parseFloat(video.duration);
  var data = loadVodProgress();
  data.items[state.vod.key] = {
    position: 0,
    duration: isFinite(dur) && dur > 0 ? Math.floor(dur) : 0,
    updated: Date.now(),
    watched: true
  };
  writeVodProgress(data);
}
var vods = { open: false, slug: '', gridIdx: 0, list: [], loading: false, hidden: 0, session: 0 };
var VOD_COLS = 4;
function setVodStatus(msg) { document.getElementById('vods-status').textContent = msg || ''; }
// Kick includes subscriber/gated recordings in the public list but with an
// empty source. They cannot be opened by this unauthenticated TV app, so do not
// render a card that appears actionable and then does nothing.
function playableVod(v) {
  if (!v || typeof v.source !== 'string') return false;
  var source = v.source.trim();
  if (!/^https?:\/\//i.test(source)) return false;
  v.source = source;
  return true;
}
// Watched state and progress fraction for a recording, from the progress store.
function vodWatchedInfo(slug, v, items) {
  var entry = items[vodProgressKey(slug, v)];
  var pdur = entry ? (entry.duration || (v.duration || 0) / 1000) : 0;
  var ppos = entry ? parseFloat(entry.position) : 0;
  var frac = (pdur > 0 && isFinite(ppos) && ppos > 0) ? Math.min(1, ppos / pdur) : 0;
  var watched = !!(entry && entry.watched) || frac >= 0.9;
  return { watched: watched, frac: watched ? 1 : frac };
}
function loadVodHideWatchedPref() {
  try { return localStorage.getItem('kicktv.vodhidewatched') === '1'; } catch (e) { return false; }
}
function applyVodFilter() {
  if (!vods.hideWatched) { vods.list = vods.listAll.slice(); return; }
  var items = loadVodProgress().items;
  vods.list = [];
  for (var i = 0; i < vods.listAll.length; i++) {
    if (!vodWatchedInfo(vods.slug, vods.listAll[i], items).watched) vods.list.push(vods.listAll[i]);
  }
}
function renderVodFilterChip() {
  var el = document.getElementById('vods-filter');
  if (el) el.className = vods.hideWatched ? 'on' : '';
}
function toggleVodHideWatched() {
  vods.hideWatched = !vods.hideWatched;
  try { localStorage.setItem('kicktv.vodhidewatched', vods.hideWatched ? '1' : '0'); } catch (e) {}
  applyVodFilter();
  vods.gridIdx = 0;
  renderVods();
  renderVodFilterChip();
  setVodStatus(vods.list.length ? ''
    : (vods.listAll.length ? 'All watched — Green shows them' : 'No past videos'));
  toast(vods.hideWatched ? 'Hiding watched videos' : 'Showing watched videos');
}
function fmtDuration(ms) {
  var s = Math.floor((ms || 0) / 1000);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  return h > 0 ? (h + ':' + pad(m) + ':' + pad(ss)) : (m + ':' + pad(ss));
}
// Kick's created_at looks like "2026-07-21 21:25:29" and is UTC. Turn it into a
// short "how long ago" label.
function fmtVodAgo(str) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str || '');
  if (!m) return '';
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  var diff = Date.now() - t;
  if (diff < 0) diff = 0;
  function n(v, unit) { return v + ' ' + unit + (v === 1 ? '' : 's') + ' ago'; }
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return n(mins, 'min');
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return n(hrs, 'hour');
  var days = Math.floor(hrs / 24);
  if (days < 7) return n(days, 'day');
  if (days < 30) return n(Math.floor(days / 7), 'week');
  if (days < 365) return n(Math.floor(days / 30), 'month');
  return n(Math.floor(days / 365), 'year');
}
function vodThumb(v) {
  var t = v && v.thumbnail;
  if (t && t.src) return t.src;
  if (v && v.video && v.video.thumb && v.video.thumb.src) return v.video.thumb.src;
  return null;
}
function openVods(slug) {
  if (!state.ready || !slug) return;
  if (browse.open) closeBrowse();
  if (settings.open) closeSettings();
  vods.open = true; vods.session++; vods.slug = slug; vods.gridIdx = 0; vods.list = []; vods.loading = true; vods.hidden = 0;
  vods.listAll = []; vods.hideWatched = loadVodHideWatchedPref();
  renderVodFilterChip();
  state.vodReturn = state.current || state.vodReturn;   // where to go back to afterwards
  showCursor();
  closeSidebar();
  pausePlaybackForBrowse();
  document.getElementById('vods').className = '';
  var name = (state.channels[slug] && state.channels[slug].name) || slug;
  document.getElementById('vods-title').textContent = 'Past videos - ' + name;
  document.getElementById('vods-grid').innerHTML = '';
  setVodStatus('Loading...');
  var ses = vods.session;
  serviceGet('/api/v2/channels/' + encodeURIComponent(slug) + '/videos', function (err, data) {
    if (ses !== vods.session) return;     // a newer opening owns the popup
    vods.loading = false;
    if (!vods.open || vods.slug !== slug) return;
    var allVods = Array.isArray(data) ? data : [];
    vods.listAll = allVods.filter(playableVod);
    vods.hidden = allVods.length - vods.listAll.length;
    // If a live session was marked and has since ended, its recording picks up
    // where the viewer left. Must run before applyVodFilter, which reads progress.
    try { resolveLiveMark(slug, vods.listAll); } catch (e) {}
    applyVodFilter();
    renderVods();
    if (!vods.list.length) {
      setVodStatus(err ? 'Could not load videos'
        : (vods.listAll.length ? 'All watched — Green shows them'
          : (vods.hidden ? 'No playable past videos' : 'No past videos')));
    }
    else setVodStatus('');
  });
}
function closeVods() {
  vods.open = false;
  document.getElementById('vods').className = 'hidden';
  if (state.current || state.vod) resumePlaybackAfterBrowse();   // a live stream or VOD was underneath
}
function renderVods() {
  var grid = document.getElementById('vods-grid');
  grid.innerHTML = '';
  var progress = loadVodProgress().items;
  vods.list.forEach(function (v, i) {
    // Saved progress for this recording: a thin bar on the thumbnail, and 90%+
    // (or finished) counts as watched — badge, fade, full bar.
    var w = vodWatchedInfo(vods.slug, v, progress);
    var watched = w.watched, frac = w.frac;
    var base = 'bcard' + (watched ? ' watched' : '');
    var card = document.createElement('div');
    card.className = base;
    card.setAttribute('data-base', base);
    card.setAttribute('data-idx', i);
    var thumb = document.createElement('div');
    thumb.className = 'bthumb';
    var url = vodThumb(v);
    if (url) thumb.style.backgroundImage = 'url(' + url + ')';
    var dur = document.createElement('span');
    dur.className = 'bdur';
    dur.textContent = fmtDuration(v.duration);
    thumb.appendChild(dur);
    var views = document.createElement('span');
    views.className = 'bviewers';
    views.textContent = fmtViewers(v.views || 0) + ' views';
    thumb.appendChild(views);
    if (frac > 0) {
      var track = document.createElement('div');
      track.className = 'bprogtrack';
      var fill = document.createElement('div');
      fill.className = 'bprogfill';
      fill.style.width = Math.round(frac * 100) + '%';
      track.appendChild(fill);
      thumb.appendChild(track);
    }
    if (watched) {
      var wbadge = document.createElement('span');
      wbadge.className = 'bwatched';
      wbadge.textContent = '✓ Watched';
      thumb.appendChild(wbadge);
    }
    card.appendChild(thumb);
    var meta = document.createElement('div');
    meta.className = 'bmeta';
    meta.innerHTML = '<div class="bname"></div><div class="btitle"></div><div class="bsub"></div>';
    meta.children[0].textContent = v.session_title || 'Untitled';
    meta.children[1].textContent = (v.categories && v.categories[0] && v.categories[0].name) || '';
    meta.children[2].textContent = fmtVodAgo(v.created_at);
    card.appendChild(meta);
    grid.appendChild(card);
  });
  if (vods.gridIdx >= vods.list.length) vods.gridIdx = Math.max(0, vods.list.length - 1);
  applyVodFocus();
}
function applyVodFocus() {
  var grid = document.getElementById('vods-grid');
  for (var j = 0; j < grid.children.length; j++) {
    var vcard = grid.children[j];
    vcard.className = (vcard.getAttribute('data-base') || 'bcard') + (j === vods.gridIdx ? ' focused' : '');
  }
  var el = grid.children[vods.gridIdx];
  if (el) {
    var top = el.offsetTop - grid.offsetTop;
    if (top < grid.scrollTop) grid.scrollTop = top - 12;
    else if (top + el.offsetHeight > grid.scrollTop + grid.clientHeight)
      grid.scrollTop = top + el.offsetHeight - grid.clientHeight + 12;
  }
}
function vodMove(dx, dy) {
  var n = vods.list.length;
  if (!n) return;
  var idx = vods.gridIdx;
  if (dx === 1 && idx < n - 1) idx++;
  else if (dx === -1 && idx > 0) idx--;
  else if (dy === 1 && idx + VOD_COLS < n) idx += VOD_COLS;
  else if (dy === 1 && Math.floor(idx / VOD_COLS) < Math.floor((n - 1) / VOD_COLS)) idx = n - 1;  // partial last row
  else if (dy === -1 && idx - VOD_COLS >= 0) idx -= VOD_COLS;
  vods.gridIdx = idx;
  applyVodFocus();
}
function vodActivate() {
  var v = vods.list[vods.gridIdx];
  if (v && v.source) {
    vods.open = false;
    document.getElementById('vods').className = 'hidden';
    // Capture this exact list as the auto-advance queue. The global VOD browser
    // can later be opened for another streamer without changing what comes next.
    playVod(v, vods.list.slice(), vods.gridIdx, vods.slug);
  }
}
function playVod(v, queue, queueIndex, slug) {
  teardownVideo();
  disconnectChat();
  setMode('player');
  state.current = null;
  state.preserveLastVodDuringLive = false;
  state.tempChannel = null;
  var vodSlug = slug || vods.slug;
  var playQueue = queue && queue.length ? queue : [v];
  var playIndex = typeof queueIndex === 'number' ? queueIndex : playQueue.indexOf(v);
  if (playIndex < 0 || playIndex >= playQueue.length) {
    playQueue = [v];
    playIndex = 0;
  }
  var progressKey = vodProgressKey(vodSlug, v);
  var resumeAt = savedVodPosition(progressKey);
  var savedEntry = loadVodProgress().items[progressKey];
  var knownDuration = (savedEntry && savedEntry.duration) || (v.duration || 0) / 1000 || 0;
  vodProgressLastWrite = 0;
  state.vod = { slug: vodSlug, source: v.source,
                title: v.session_title || 'Past video',
                name: (state.channels[vodSlug] && state.channels[vodSlug].name) || vodSlug,
                queue: playQueue, queueIndex: playIndex,
                markerId: vodStableId(v),
                key: progressKey, resumeAt: resumeAt, resumeApplied: false,
                knownDuration: knownDuration,
                progressReady: false, completed: false, ending: false, retries: 0 };
  saveLastVod(vodSlug, v, state.vod.name);
  PB.slug = null; PB.reloading = false; PB.reconnects = 0; PB.lastError = '';
  setBanner('');
  showState('hidden');
  updateGear();
  // Pre-set the bar from what we already know (saved resume point + listed
  // duration), so a resumed VOD does not sit at 0:00 and then jump once
  // playback actually starts.
  drawVodBar(resumeAt, knownDuration);
  attachVod(v.source);
  showVodOverlay();
}
// The API list is rendered newest to oldest, so the next card in that visible
// order is the next queue item. Source-less entries are skipped defensively even
// though openVods() already filters them out.
function nextQueuedVod(vodState) {
  if (!vodState || !Array.isArray(vodState.queue)) return null;
  for (var i = (vodState.queueIndex || 0) + 1; i < vodState.queue.length; i++) {
    if (playableVod(vodState.queue[i])) return { item: vodState.queue[i], index: i };
  }
  return null;
}
function advanceVodOrExit() {
  var finished = state.vod;
  if (!finished) return;
  clearLastVodMatch(finished.slug, finished.markerId);
  if (settings.autoadvance) {
    var next = nextQueuedVod(finished);
    if (next) {
      toast('Up next: ' + (next.item.session_title || 'Past video'));
      playVod(next.item, finished.queue, next.index, finished.slug);
      return;
    }
  }
  toast('Video ended');
  exitVod();
}
function attachVod(source) {
  var video = document.getElementById('video');
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  if (state.vod) { state.vod.resumeApplied = false; state.vod.progressReady = false; }
  liveWatchStartedMs = 0;            // a recording is not a live session
  if (window.Hls && Hls.isSupported()) {
    var hls = new Hls({
      enableWorker: true, capLevelToPlayerSize: true, maxBufferLength: 30,
      manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6,
      startPosition: state.vod && state.vod.resumeAt > 0 ? state.vod.resumeAt : -1
    });
    state.hls = hls;
    hls.on(Hls.Events.ERROR, function (ev, data) {
      if (data && data.details) PB.lastError = data.details;
      if (state.hls !== hls || !data || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        // in-place recovery is not free: after a few consecutive failures fall
        // through to reloadVod so its bounded retry/exit ceiling applies
        if (state.vod) state.vod.mediaRecoveries = (state.vod.mediaRecoveries || 0) + 1;
        if (state.vod && state.vod.mediaRecoveries > MAX_MEDIA_RETRY) reloadVod();
        else { try { hls.recoverMediaError(); } catch (e) { reloadVod(); } }
      }
      else reloadVod();
    });
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      if (state.hls !== hls) return;
      applyQualityPref();
      if (qualityopt && qualityopt.open) refreshQualityOpt();
    });
    if (Hls.Events.LEVEL_SWITCHED) {
      hls.on(Hls.Events.LEVEL_SWITCHED, function () {
        if (state.hls === hls) updateQualityButton();
      });
    }
    if (Hls.Events.FRAG_LOADED) {
      hls.on(Hls.Events.FRAG_LOADED, function (ev, d) { diagCountFrag(d); });
    }
    try { hls.loadSource(source); hls.attachMedia(video); }
    catch (e) { reloadVod(); return; }
  } else {
    try { video.src = source; } catch (e) { toast('Cannot play this video'); exitVod(); return; }
  }
  PB.active = true;
  playVideo(video);
}
function reloadVod() {
  if (!state.vod) return;
  var video = document.getElementById('video');
  if (isFinite(video.currentTime) && video.currentTime > 0) state.vod.resumeAt = Math.max(0, video.currentTime - 1);
  state.vod.retries = (state.vod.retries || 0) + 1;
  PB.reconnects++;
  if (state.vod.retries > 4) { toast('Playback error'); exitVod(); return; }
  setBanner('Reconnecting...');
  attachVod(state.vod.source);
}
function exitVod() {
  var back = state.vodReturn;
  var leaving = state.vod;
  teardownVideo();
  if (leaving) clearLastVodMatch(leaving.slug, leaving.markerId);
  state.vod = null;
  state.vodReturn = null;
  setBanner('');
  if (back && state.channels[back] && state.channels[back].live) play(back);
  else { state.current = null; updateGear(); showNothing(); }
}
/* Rapid seek presses accumulate (+30, +60, +90...) and apply as one jump after
   a short pause, YouTube-style. Nothing actually seeks until the timeout, so
   the skip buttons stay on screen while you keep pressing. */
var seekAccum = { delta: 0, timer: null, baseTime: null };
var SEEK_APPLY_MS = 1200;
function seekVod(delta) {
  var video = document.getElementById('video');
  var d = video.duration;
  if (!state.vod || !d || isNaN(d)) return;
  if (seekAccum.baseTime === null) seekAccum.baseTime = video.currentTime || 0;
  seekAccum.delta += delta;
  var el = document.getElementById('seekpop');
  el.textContent = (seekAccum.delta >= 0 ? '+' : '-') + Math.abs(seekAccum.delta) + 's';
  el.className = '';   // dim handling comes from applyDimAwareUi, same as the buttons
  clearTimeout(seekAccum.timer);
  seekAccum.timer = setTimeout(applySeekAccum, SEEK_APPLY_MS);
  showVodOverlay();
  drawVodBarNow();               // preview the pending target on the bar right away
}
function applySeekAccum() {
  clearTimeout(seekAccum.timer);
  seekAccum.timer = null;
  var base = seekAccum.baseTime, dd = seekAccum.delta;
  seekAccum.baseTime = null; seekAccum.delta = 0;
  document.getElementById('seekpop').className = 'hidden';
  if (!state.vod || !dd) return;
  var video = document.getElementById('video');
  if (!isFinite(video.duration) || !video.duration) return;
  var t = Math.max(0, Math.min(video.duration - 1, (base === null ? (video.currentTime || 0) : base) + dd));
  try { video.currentTime = t; } catch (e) {}
  showVodOverlay();
}
function resetSeekAccum() {
  clearTimeout(seekAccum.timer);
  seekAccum.timer = null;
  seekAccum.delta = 0; seekAccum.baseTime = null;
  var el = document.getElementById('seekpop');
  if (el) el.className = 'hidden';
}
function showVodOverlay() {
  if (!state.vod) return;
  var ov = document.getElementById('overlay');
  var vc = state.channels[state.vod.slug];
  setOverlayAvatar(vc && vc.avatar, state.vod.name);
  document.getElementById('ov-name').textContent = state.vod.name;
  document.getElementById('ov-live').style.display = 'none';
  document.getElementById('ov-viewers').textContent = 'Past video';
  document.getElementById('ov-title').textContent = state.vod.title;
  // start at the sidebar's right edge when it is open, like the live overlay,
  // so the info is never hidden behind the sidebar panel
  ov.style.left = state.sidebarOpen ? '470px' : '0';
  ov.style.width = state.sidebarOpen ? '1450px' : '1920px';
  ov.className = '';
  showVodBar();
  showVodPlay();
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(function () {
    if (state.sidebarOpen) return;   // sidebar is up: the whole UI hides together when it closes
    ov.className = 'hidden';
    hideVodPlay();
    hideVodBar();
  }, 4000);
}
// The seek bar: a wavy line for the played part, a flat line for the rest, and a
// vertical handle at the play head. Redrawn a couple of times a second while up.
var vodbarTimer = null;
var vodDragging = false;
function fmtClock(sec) { return fmtDuration((sec || 0) * 1000); }
function drawVodBar(cur, dur) {
  var W = 1500, mid = 20;
  var prog = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
  var px = prog * W;
  document.getElementById('vodbar-played').setAttribute('d', 'M0,' + mid + ' L' + px.toFixed(1) + ',' + mid);
  document.getElementById('vodbar-remain').setAttribute('x1', px.toFixed(1));
  document.getElementById('vodbar-handle').setAttribute('x', (px - 4).toFixed(1));
  document.getElementById('vodbar-cur').textContent = fmtClock(cur);
  document.getElementById('vodbar-dur').textContent = fmtClock(dur);
}
// The bar is a fixed, centred width now (see CSS), so nothing to reposition.
function placeVodBar() {}
function drawVodBarNow() {
  var v = document.getElementById('video');
  if (!state.vod || vodDragging) return;
  var dur = (isFinite(v.duration) && v.duration) ? v.duration : (state.vod.knownDuration || 0);
  if (!dur) return;
  var cur = v.currentTime || 0;
  if (seekAccum.baseTime !== null) {
    // a queued relative seek is pending: preview its target
    cur = Math.max(0, Math.min(dur - 1, seekAccum.baseTime + seekAccum.delta));
  }
  // While the resume seek is still pending, keep showing the target position
  // rather than a transient 0:00.
  else if (state.vod.resumeAt > 0 && !state.vod.resumeApplied && cur < state.vod.resumeAt) cur = state.vod.resumeAt;
  placeVodBar();
  drawVodBar(cur, dur);
}
function showVodBar() {
  if (!state.vod) return;                // seek bar is for past videos only, never live
  document.getElementById('vodbar').className = '';
  placeDiagnostics();
  placeVodBar();
  drawVodBarNow();
  if (!vodbarTimer) vodbarTimer = setInterval(drawVodBarNow, 500);
}
// Jump to a fraction (0..1) of the video, used by pointer clicks on the bar.
function seekVodFrac(frac) {
  var v = document.getElementById('video');
  if (!state.vod || !isFinite(v.duration) || !v.duration) return;
  resetSeekAccum();               // an absolute scrub overrides any queued relative seek
  frac = Math.max(0, Math.min(1, frac));
  try { v.currentTime = frac * v.duration; } catch (e) {}
  showVodOverlay();
}
function hideVodBar() {
  document.getElementById('vodbar').className = 'hidden';
  placeDiagnostics();
  if (vodbarTimer) { clearInterval(vodbarTimer); vodbarTimer = null; }
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
  var levels = state.hls.levels, best = -1, bestH = -1, bestRate = -1;
  var maxIdx = 0, maxH = -1, maxRate = -1;
  for (var i = 0; i < levels.length; i++) {
    var h = levels[i].height || 0;
    var rate = levels[i].bitrate || 0;
    if (h > maxH || (h === maxH && rate > maxRate)) {
      maxH = h; maxRate = rate; maxIdx = i;
    }
    if (h <= quality.sel && (h > bestH || (h === bestH && rate > bestRate))) {
      bestH = h; bestRate = rate; best = i;
    }
  }
  return best !== -1 ? best : maxIdx;
}
function applyQualityPref() {
  if (state.hls) {
    try { state.hls.currentLevel = levelIndexForPref(); } catch (e) {}
  }
  updateQualityButton();
}
function qualityLevelLabel(level) {
  if (!level) return 'Unknown';
  var fps = (level.attrs && level.attrs['FRAME-RATE'])
    ? Math.round(parseFloat(level.attrs['FRAME-RATE'])) : 0;
  var label = level.height
    ? (level.height + 'p') : (Math.round((level.bitrate || 0) / 1000) + 'k');
  if (fps >= 50) label += String(fps);
  return label;
}
// Build the quality rows: Auto on top, then the stream's levels high to low.
function qualityRows() {
  var rows = [{ label: 'Auto', auto: true, h: -1, idx: -1 }];
  if (state.hls && state.hls.levels && state.hls.levels.length) {
    var lv = [], byHeight = {};
    state.hls.levels.forEach(function (l, i) {
      var h = l.height || 0, rate = l.bitrate || 0, key = String(h);
      var candidate = { label: qualityLevelLabel(l), auto: false, h: h, idx: i, bitrate: rate };
      // The saved preference is a height, so showing multiple bitrate variants
      // at that same height would create duplicate selected cards. Keep the best.
      if (!byHeight[key] || rate > byHeight[key].bitrate) byHeight[key] = candidate;
    });
    for (var key in byHeight) {
      if (Object.prototype.hasOwnProperty.call(byHeight, key)) lv.push(byHeight[key]);
    }
    lv.sort(function (a, b) { return b.h - a.h || b.bitrate - a.bitrate; });
    rows = rows.concat(lv);
  }
  return rows;
}
function qualityIsSel(row) {
  if (row.auto) return quality.sel === 'auto';
  return quality.sel !== 'auto' && row.idx === levelIndexForPref();
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
  updateQualityButton();
}

/* Player options that ride on top of hls.js */
// Low latency trims how far behind the live edge we play. It only takes hold on
// a fresh hls instance, so toggling it reloads the current stream.
function hlsConfig() {
  var cfg = {
    enableWorker: true, capLevelToPlayerSize: true,
    lowLatencyMode: !!settings.lowlatency,
    backBufferLength: 90, liveBackBufferLength: 90,
    manifestLoadingMaxRetry: 4, manifestLoadingRetryDelay: 1000,
    levelLoadingMaxRetry: 4, levelLoadingRetryDelay: 1000,
    fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000
  };
  if (settings.lowlatency) {
    cfg.lowLatencyMode = true;
    cfg.liveSyncDurationCount = 2;
    cfg.maxLiveSyncPlaybackRate = 1.5;
    cfg.maxBufferLength = 10;
  } else {
    cfg.maxBufferLength = 30;
    cfg.maxLiveSyncPlaybackRate = 1;
  }
  return cfg;
}
function liveSeekRange(video) {
  var ranges = video && video.seekable;
  if (!ranges || !ranges.length) return null;
  var t = video.currentTime || 0;
  for (var i = 0; i < ranges.length; i++) {
    if (t >= ranges.start(i) - 0.25 && t <= ranges.end(i) + 0.25) {
      return { start: ranges.start(i), end: ranges.end(i) };
    }
  }
  var last = ranges.length - 1;
  return { start: ranges.start(last), end: ranges.end(last) };
}
function liveTarget(video, range) {
  var target = NaN;
  if (state.hls) {
    try { target = state.hls.liveSyncPosition; } catch (e) {}
  }
  if (typeof target !== 'number' || !isFinite(target) ||
      target < range.start || target > range.end) target = range.end - 1;
  return Math.max(range.start, Math.min(range.end - 0.1, target));
}

/* Optional playback diagnostics. This deliberately reads only public media and
   hls.js state, so turning it on cannot change playback behavior. */
var diagnosticsTimer = null;
var diagnosticsSample = { at: 0, frames: 0, fps: 0 };
// Actual bytes downloaded by the player (fed by FRAG_LOADED). The network
// graph shows real usage — not hls.js's link-capacity estimate, which on a
// fast line reads absurdly high and only ever climbs.
var diagBytes = 0;
var diagRate = { lastBytes: 0, at: 0, mbps: 0 };
function diagCountFrag(d) {
  try {
    var st = (d && d.frag && d.frag.stats) || (d && d.stats) || null;
    if (st && st.total) diagBytes += st.total;
    else if (st && st.loaded) diagBytes += st.loaded;
  } catch (e) {}
}
function diagnosticBufferAhead(video) {
  var t = video.currentTime || 0, ranges = video.buffered;
  if (!ranges) return 0;
  try {
    for (var i = 0; i < ranges.length; i++) {
      if (t >= ranges.start(i) - 0.1 && t <= ranges.end(i) + 0.1) {
        return Math.max(0, ranges.end(i) - t);
      }
    }
  } catch (e) {}
  return 0;
}
function diagnosticFrameStats(video, fallbackFps) {
  var total = 0, dropped = 0;
  try {
    if (video.getVideoPlaybackQuality) {
      var q = video.getVideoPlaybackQuality();
      total = q.totalVideoFrames || 0;
      dropped = q.droppedVideoFrames || 0;
    } else {
      total = video.webkitDecodedFrameCount || 0;
      dropped = video.webkitDroppedFrameCount || 0;
    }
  } catch (e) {}
  var now = Date.now();
  if (total && diagnosticsSample.at && total >= diagnosticsSample.frames) {
    var elapsed = (now - diagnosticsSample.at) / 1000;
    if (elapsed >= 0.25) diagnosticsSample.fps = (total - diagnosticsSample.frames) / elapsed;
  }
  if (!diagnosticsSample.at || now - diagnosticsSample.at >= 250) {
    diagnosticsSample.at = now;
    diagnosticsSample.frames = total;
  }
  return {
    total: total,
    dropped: dropped,
    fps: diagnosticsSample.fps > 0 ? diagnosticsSample.fps : (fallbackFps || 0)
  };
}
function diagnosticChatStatus() {
  if (!settings.chat) return 'off';
  if (typeof chat === 'undefined' || !chat.want) return 'idle';
  if (chat.ws && chat.ws.readyState === 1) return 'connected';
  if (chat.ws && chat.ws.readyState === 0) return 'connecting';
  return 'retrying';
}
// Rolling one-minute history feeding the two sparkline graphs.
var diagHistory = { net: [], buf: [] };
function diagPushSample(arr, v) {
  arr.push(v);
  while (arr.length > 60) arr.shift();
}
function diagDrawSpark(lineId, arr, minMax) {
  var max = minMax;
  for (var i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  var pts = [];
  for (var j = 0; j < arr.length; j++) {
    pts.push((j * (180 / 59)).toFixed(1) + ',' + (38 - (arr[j] / max) * 34).toFixed(1));
  }
  var el = document.getElementById(lineId);
  if (el) el.setAttribute('points', pts.join(' '));
  return max;                    // callers can place reference lines on this scale
}
function syncDiagnostics() {
  clearInterval(diagnosticsTimer);
  diagnosticsTimer = null;
  diagnosticsSample = { at: 0, frames: 0, fps: 0 };
  diagHistory = { net: [], buf: [] };
  diagBytes = 0;
  diagRate = { lastBytes: 0, at: 0, mbps: 0 };
  diagManualPos = false;      // toggling returns the window to its default spot
  diagDrag = null;
  var dEl = document.getElementById('diagnostics');
  if (dEl) dEl.style.top = 'auto';
  if (!settings.diagnostics) {
    document.getElementById('diagnostics').className = 'hidden';
    return;
  }
  drawDiagnostics();
  diagnosticsTimer = setInterval(drawDiagnostics, 1000);
}
var diagDrag = null;        // active drag: pointer offset into the panel
var diagManualPos = false;  // the user parked the window somewhere — stop auto-placing
function placeDiagnostics() {
  if (diagManualPos) return;
  var el = document.getElementById('diagnostics');
  if (!el) return;
  var vodbar = document.getElementById('vodbar');
  var vodControls = state.vod && vodbar.className.indexOf('hidden') === -1;
  var chatBox = document.getElementById('chat');
  var chatOnLeft = settings.chatSide === 'left' && chatBox.classList.contains('on');
  el.style.left = chatOnLeft ? 'auto' : (state.sidebarOpen ? '500px' : '30px');
  el.style.right = chatOnLeft ? '30px' : 'auto';
  el.style.bottom = vodControls ? '300px' : (state.sidebarOpen ? '150px' : '30px');   // above the raised seek bar
}
function drawDiagnostics() {
  var el = document.getElementById('diagnostics');
  if (!el) return;
  if (!settings.diagnostics || (!state.current && !state.vod)) {
    el.className = 'hidden';
    return;
  }
  var video = document.getElementById('video');
  var status = video.error ? 'Error' :
    (video.paused ? 'Paused' : (video.readyState < 3 ? 'Buffering' : 'Playing'));
  var hls = state.hls, level = null, levelIndex = -1, levelCount = 0;
  if (hls) {
    try {
      levelCount = hls.levels ? hls.levels.length : 0;
      levelIndex = hls.currentLevel;
      if (levelIndex < 0) levelIndex = hls.loadLevel;
      if (levelIndex < 0) levelIndex = hls.nextAutoLevel;
      if (levelIndex >= 0 && hls.levels) level = hls.levels[levelIndex];
    } catch (e) {}
  }
  var width = video.videoWidth || (level && level.width) || 0;
  var height = video.videoHeight || (level && level.height) || 0;
  var declaredFps = 0;
  if (level) {
    declaredFps = parseFloat(level.frameRate || (level.attrs && level.attrs['FRAME-RATE'])) || 0;
  }
  var frames = diagnosticFrameStats(video, declaredFps);
  var qualityMode = 'Native';
  if (hls) {
    try {
      qualityMode = hls.autoLevelEnabled ? 'Auto' :
        (quality.sel === 'auto' ? 'Fixed' : 'Fixed ' + quality.sel + 'p');
    } catch (e) { qualityMode = quality.sel === 'auto' ? 'Auto' : ('Fixed ' + quality.sel + 'p'); }
  }
  var qualityText = qualityMode;
  if (levelIndex >= 0) {
    qualityText += ' L' + (levelIndex + 1) + (levelCount ? '/' + levelCount : '');
  }
  var bitrate = level && (level.maxBitrate || level.bitrate);
  if (bitrate) qualityText += ' · ' + (bitrate / 1000000).toFixed(1) + ' Mbps';
  var liveDelay = NaN;
  if (state.current) {
    try { if (hls) liveDelay = hls.latency; } catch (e) {}
    if (typeof liveDelay !== 'number' || !isFinite(liveDelay) || liveDelay < 0) {
      try {
        var liveRange = liveSeekRange(video);
        if (liveRange) liveDelay = Math.max(0, liveRange.end - (video.currentTime || 0));
      } catch (e) {}
    }
  }
  var droppedPct = frames.total ? (frames.dropped * 100 / frames.total) : 0;
  var firstLine = (state.vod ? 'VOD' : 'LIVE') + ' · ' + status;
  if (state.current && isFinite(liveDelay)) {
    firstLine += liveDelay < 2.5 ? ' · Live edge' : ' · ' + Math.round(liveDelay) + 's behind';
  }
  var resolution = width && height ? (width + '×' + height) : 'Resolution —';
  if (frames.fps) resolution += ' @ ' + Math.round(frames.fps) + ' fps';
  var lines = [
    firstLine,
    resolution + ' · ' + qualityText,
    'Frames ' + (frames.total || '—') + ' · Dropped ' + frames.dropped +
      (frames.total ? ' (' + droppedPct.toFixed(2) + '%)' : ''),
    'Recovery ' + PB.reconnects + ' · Net ' + PB.netRetries + ' · Media ' + PB.mediaRetries +
      ' · Chat ' + diagnosticChatStatus(),
    'Service ' + (state.netDown ? 'offline' : 'online') +
      (PB.lastError ? ' · Last ' + String(PB.lastError).slice(0, 38) : '')
  ];
  document.getElementById('diag-lines').textContent = lines.join('\n');
  // Feed the sparklines: measured download rate and seconds of buffered media.
  var bufAhead = diagnosticBufferAhead(video);
  var nowT = Date.now();
  var mbpsTick = 0;
  if (diagRate.at) {
    var dt = (nowT - diagRate.at) / 1000;
    var db = diagBytes - diagRate.lastBytes;
    if (dt > 0 && db >= 0) mbpsTick = (db * 8) / dt / 1000000;
  }
  diagRate.at = nowT;
  diagRate.lastBytes = diagBytes;
  diagRate.mbps = diagRate.mbps ? (diagRate.mbps * 0.5 + mbpsTick * 0.5) : mbpsTick;  // light smoothing
  var netMbps = diagRate.mbps;
  diagPushSample(diagHistory.net, netMbps);
  diagPushSample(diagHistory.buf, bufAhead);
  diagDrawSpark('diag-net-line', diagHistory.net, 1);   // floors keep flat lines readable
  diagDrawSpark('diag-buf-line', diagHistory.buf, 5);
  document.getElementById('diag-net-now').textContent = netMbps ? netMbps.toFixed(1) + ' Mbps' : '—';
  document.getElementById('diag-buf-now').textContent = bufAhead.toFixed(1) + 's';
  el.style.filter = settings.dim && settings.dimScope !== 'all' ? popupDimFilter() : '';
  placeDiagnostics();
  el.className = '';
}
// The next live favorite after `slug`, used by auto-advance when a stream ends.
function nextLiveAfter(slug) {
  for (var i = 0; i < state.order.length; i++) {
    var s = state.order[i];
    if (s !== slug && state.channels[s] && state.channels[s].live &&
        !isChannelBlocked(state.channels[s])) return s;
  }
  return null;
}
function firstLivePinned(slug) {
  for (var i = 0; i < state.order.length; i++) {
    var s = state.order[i];
    if (s !== slug && state.channels[s] && state.channels[s].live &&
        !isChannelBlocked(state.channels[s]) && isPinned(s)) return s;
  }
  return null;
}

/* Settings menu (opened by the gear, or the Yellow button, while the list is open) */
var settings = { open: false, focus: 0, items: [],
                 chat: false, lowlatency: false, autoadvance: false,
                 hideOffline: false, diagnostics: false,
                 dim: false, rememberDim: false, dimStrength: 0.8, dimScope: 'video',
                 chatSide: 'right', chatSize: 'medium', chatWidth: 'medium', chatOpacity: 'high',
                 chatBackground: 'dark', chatFade: 40000, chatBots: 'show',
                 chatEmotes: 'images', chatTimestamps: false,
                 alerts: 'all', saverMin: 5 };
var SETTINGS_IDLE_MS = 30000;
var settingsIdleTimer = null;
function touchSettings() {
  if (!settings.open && !(qualityopt && qualityopt.open)) return;
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
  settings.chat = !!s.chat;
  settings.lowlatency = !!s.lowlatency;
  settings.autoadvance = !!s.autoadvance;
  settings.hideOffline = !!s.hideOffline;
  settings.diagnostics = !!s.diagnostics;
  settings.rememberDim = s.rememberDim === true;
  settings.dim = settings.rememberDim && s.dim === true;
  var st = parseFloat(s.dimStrength);
  settings.dimStrength = (st >= 0.1 && st <= 0.98) ? st : 0.8;
  settings.dimScope = (s.dimScope === 'all') ? 'all' : 'video';
  // Chat overlay look & filters
  settings.chatSide = pickEnum(s.chatSide, ['right', 'left'], 'right');
  settings.chatSize = pickEnum(s.chatSize, ['small', 'medium', 'large'], 'medium');
  settings.chatWidth = pickEnum(s.chatWidth, ['narrow', 'medium', 'wide'], 'medium');
  settings.chatOpacity = pickEnum(s.chatOpacity, ['low', 'medium', 'high'], 'high');
  settings.chatBackground = pickEnum(s.chatBackground, ['off', 'light', 'dark'], 'dark');
  var cf = parseInt(s.chatFade, 10);
  settings.chatFade = ([0, 10000, 20000, 40000].indexOf(cf) !== -1) ? cf : 40000;
  settings.chatBots = pickEnum(s.chatBots, ['show', 'hide'], 'show');
  settings.chatEmotes = pickEnum(s.chatEmotes, ['images', 'text'], 'images');
  settings.chatTimestamps = !!s.chatTimestamps;
  // Alerts + burn-in guard
  settings.alerts = pickEnum(s.alerts, ['all', 'pinned', 'off'], 'all');
  var sm = parseInt(s.saverMin, 10);
  settings.saverMin = ([0, 3, 5, 10].indexOf(sm) !== -1) ? sm : 5;
}
function saveSettings() {
  try {
    localStorage.setItem('kicktv.settings', JSON.stringify({
      chat: settings.chat, lowlatency: settings.lowlatency, autoadvance: settings.autoadvance,
      hideOffline: settings.hideOffline, diagnostics: settings.diagnostics,
      dim: settings.rememberDim ? settings.dim : false, rememberDim: settings.rememberDim,
      dimStrength: settings.dimStrength, dimScope: settings.dimScope,
      chatSide: settings.chatSide, chatSize: settings.chatSize, chatWidth: settings.chatWidth,
      chatOpacity: settings.chatOpacity, chatBackground: settings.chatBackground,
      chatFade: settings.chatFade, chatBots: settings.chatBots,
      chatEmotes: settings.chatEmotes, chatTimestamps: settings.chatTimestamps,
      alerts: settings.alerts, saverMin: settings.saverMin
    }));
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
    { kind: 'blockedcats', label: 'Blocked categories' },
    { kind: 'toggle', key: 'diagnostics', label: 'Diagnostics' },
    { kind: 'dimopt', label: 'Dim (night)' },
    { kind: 'choice', key: 'alerts', label: 'Live alerts',
      values: [{ v: 'all', label: 'All' }, { v: 'pinned', label: 'Pinned only' }, { v: 'off', label: 'Off' }] },
    { kind: 'choice', key: 'saverMin', label: 'Burn-in guard',
      values: [{ v: 3, label: '3 min' }, { v: 5, label: '5 min' }, { v: 10, label: '10 min' }, { v: 0, label: 'Off' }] }
  ];
  // (The update entry lives as a chip in the Settings header, not a list row.)
  return items;
}
function firstFocusableSetting() {
  for (var i = 0; i < settings.items.length; i++) if (settings.items[i].kind !== 'header') return i;
  return 0;
}
function openSettings() {
  if (!state.ready || settings.open) return;
  hideQualityHint();
  settings.open = true;
  setMode('settings');
  settings.items = settingsBuild();
  settings.focus = firstFocusableSetting();
  document.getElementById('settingsmodal').className = '';
  renderSettingsVer();
  renderSettings();
  touchSettings();
}
function closeSettings() {
  clearTimeout(settingsIdleTimer);
  settingsIdleTimer = null;
  settings.open = false;
  document.getElementById('settingsmodal').className = 'hidden';
  document.getElementById('settings-desc').className = 'hidden';
  setMode('player');
  if (state.sidebarOpen) resetIdle();
  pumpNotify();
}
function renderSettings() {
  var list = document.getElementById('settings-list');
  list.innerHTML = '';
  settings.items.forEach(function (it, i) {
    var el = document.createElement('div');
    el.setAttribute('data-idx', i);
    if (it.kind === 'header') {
      el.className = 'shead';
      el.textContent = it.label;
      list.appendChild(el);
      return;
    }
    if (it.kind === 'toggle' || it.kind === 'dimopt' || it.kind === 'chatopt') {
      el.setAttribute('data-focusable', '1');
      var lab = document.createElement('span'); lab.className = 'slabel'; lab.textContent = it.label;
      el.appendChild(lab);
      if (it.kind === 'dimopt' || it.kind === 'chatopt') {   // gear sits just left of the On/Off switch
        var gear = document.createElement('span'); gear.className = 'sgear';
        gear.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" style="width:22px;height:22px;vertical-align:middle"><path d="M19.14 12.94a7.5 7.5 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a7.3 7.3 0 00-1.62-.94l-.36-2.54A.5.5 0 0013.9 3h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.66 9.5a.5.5 0 00.12.64l2.03 1.58a7.5 7.5 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54a.5.5 0 00.5.42h3.84a.5.5 0 00.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96a.5.5 0 00.61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/></svg>';
        el.appendChild(gear);
      }
      var on = it.kind === 'dimopt' ? settings.dim : (it.kind === 'chatopt' ? settings.chat : !!settings[it.key]);
      var pill = document.createElement('span'); pill.className = 'spill' + (on ? ' on' : ''); pill.textContent = on ? 'On' : 'Off';
      el.appendChild(pill);
    } else if (it.kind === 'blockedcats') {
      el.setAttribute('data-focusable', '1');
      var blab = document.createElement('span'); blab.className = 'slabel'; blab.textContent = it.label;
      var bpill = document.createElement('span'); bpill.className = 'spill';
      bpill.textContent = String(getBlockedCats().length);
      el.appendChild(blab); el.appendChild(bpill);
    } else if (it.kind === 'choice') {
      el.setAttribute('data-focusable', '1');
      var clab = document.createElement('span'); clab.className = 'slabel'; clab.textContent = it.label;
      var cpill = document.createElement('span'); cpill.className = 'spill'; cpill.textContent = choiceLabel(it);
      el.appendChild(clab); el.appendChild(cpill);
    }
    list.appendChild(el);
  });
  applySettingsFocus();
}
function applySettingsFocus() {
  var list = document.getElementById('settings-list');
  var focused = null;
  for (var i = 0; i < list.children.length; i++) {
    var el = list.children[i], it = settings.items[i];
    if (!it || it.kind === 'header') continue;
    el.className = 'srow' + (i === settings.focus ? ' focused' : '');
    if (i === settings.focus) {
      focused = el;
      var top = el.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top - 6;
      else if (top + el.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = top + el.offsetHeight - list.clientHeight + 6;
    }
  }
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
function settingsActivate() {
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
    settings.chat = !settings.chat;            // the row itself just toggles chat on/off
    saveSettings();
    applyToggle('chat');
    renderSettings();
  } else if (it.kind === 'blockedcats') {
    openBlockedCats();                         // no toggle semantics; Right opens it too
  } else if (it.kind === 'choice') {
    cycleChoice(it);
    renderSettings();
  }
}
function settingsOk() {
  var it = settings.items[settings.focus];
  if (it && it.kind === 'dimopt') openDimOpt();
  else if (it && it.kind === 'chatopt') openChatOpt();
  else if (it && it.kind === 'blockedcats') openBlockedCats();
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
  var nv = it.values[((idx + dir) % n + n) % n];
  settings[it.key] = nv.v;
  saveSettings();
  if (it.key === 'alerts') pruneNotifications();
  toast(it.label + ': ' + nv.label);
}
/* A short description of the focused setting, shown in the detached context
   card used by the original Settings layout. */
var SETTINGS_DESC = {
  chat: 'Show read-only Kick chat. Press OK or use the gear for layout, background and message options.',
  lowlatency: 'Stay closer to live. This may buffer more on a slower connection.',
  autoadvance: 'Continue with the next VOD from that streamer, or another live channel. Live pinned channels come first.',
  hideOffline: 'Put offline channels in a collapsed group at the bottom. Open the group whenever you need it.',
  blockedcats: 'Categories you would rather not see. Followed channels streaming in one drop to the bottom of the list, greyed out, and stay quiet. Block a category from Browse, then Categories.',
  diagnostics: 'Show playback quality, network, buffer, live delay, frame and recovery information.',
  dim: 'Reduce screen brightness. Press OK or use the gear for strength, scope and startup behavior, or press 0 while watching.',
  alerts: 'Choose which followed channels may show a five-second live alert.',
  saverMin: 'Dim a still screen after this much idle time. Any remote or pointer input wakes it.'
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
  if (it.kind === 'toggle' || it.kind === 'choice') return SETTINGS_DESC[it.key] || '';
  return '';
}
function showSettingDesc(id, text, target) {
  var el = document.getElementById(id);
  if (!el) return;
  if (!text || !target || !settings.open || updateopen || (qualityopt && qualityopt.open)) {
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
  var settingsPopups = ['settingsbox', 'dimoptbox', 'chatoptbox', 'blockedcatsbox'];
  var upperPopups = ['confirmbox', 'addbox', 'updatebox', 'qualityoptbox', 'toast'];
  var lowerPopups = ['browse-panel', 'cats-panel', 'vods-panel', 'chpop-panel',
                     'pbstatus', 'overlay', 'vodbar', 'vodplay', 'vodback', 'vodfwd', 'seekpop', 'spinner'];
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
  drawDiagnostics();
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
  if (el) el.textContent = qualityCurrentLabel();
  var button = document.getElementById('quality-button');
  var mark = button && button.querySelector('.quality-mark');
  var status = qualityPlaybackStatus();
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
  document.getElementById('settings-desc').className = 'hidden';
  document.getElementById('qualityoptmodal').className = '';
  refreshQualityOpt();
  touchSettings();
}
function closeQualityOpt() {
  qualityopt.open = false;
  document.getElementById('qualityoptmodal').className = 'hidden';
  updateQualityButton();
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
}
function qualityoptMove(delta) {
  var cur = qualityopt.focus, next = cur + delta, n = qualityopt.items.length;
  if (next < 0 || next >= n) return;
  if (next !== cur) { qualityopt.focus = next; renderQualityOpt(); }
}
function qualityoptActivate() {
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
    { label: 'Strength', value: dimStrengthLabel() },
    { label: 'Apply to', value: settings.dimScope === 'all' ? 'Everything' : 'Video only' },
    { label: 'Remember dim', value: settings.rememberDim ? 'On' : 'Off', on: settings.rememberDim }
  ];
  var list = document.getElementById('dimopt-list');
  list.innerHTML = '';
  rows.forEach(function (r, i) {
    var el = document.createElement('div');
    el.className = 'srow' + (i === dimopt.focus ? ' focused' : '');
    el.setAttribute('data-idx', i);
    var lab = document.createElement('span'); lab.className = 'slabel'; lab.textContent = r.label;
    var pill = document.createElement('span'); pill.className = 'spill' + (r.on ? ' on' : ''); pill.textContent = r.value;
    el.appendChild(lab); el.appendChild(pill);
    list.appendChild(el);
  });
  showSettingDesc('settings-desc', DIMOPT_DESC[dimopt.focus] || '', list.children[dimopt.focus]);
}
function dimoptMove(delta) {
  var n = dimopt.focus + delta;
  if (n < 0 || n >= DIMOPT_DESC.length) return;
  dimopt.focus = n;
  renderDimOpt();
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

/* Live chat options popup, opened from the gear on the Settings "Live chat" row.
   Each row toggles (Chat, Timestamps) or cycles through a set of values. */
var chatopt = { open: false, focus: 0 };
var CHATOPT_ROWS = [
  { key: 'chat',           label: 'Chat',         bool: true, desc: 'Turn the read-only chat overlay on or off.' },
  { key: 'chatSide',       label: 'Side',         vals: [['right', 'Right'], ['left', 'Left']], desc: 'Which side of the screen chat sits on.' },
  { key: 'chatSize',       label: 'Text size',    vals: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], desc: 'Font size of chat messages.' },
  { key: 'chatWidth',      label: 'Width',        vals: [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']], desc: 'How wide the chat column is.' },
  { key: 'chatOpacity',    label: 'Opacity',      vals: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], desc: 'How see-through the chat overlay is.' },
  { key: 'chatBackground', label: 'Background',   vals: [['off', 'Off'], ['light', 'Light'], ['dark', 'Dark']], desc: 'Choose how much dark background sits behind chat messages.' },
  { key: 'chatFade',       label: 'Fade after',   vals: [[10000, '10s'], [20000, '20s'], [40000, '40s'], [0, 'Never']], desc: 'How long a message stays before it fades out. Never keeps it until it scrolls off.' },
  { key: 'chatBots',       label: 'Bot messages', vals: [['show', 'Show'], ['hide', 'Hide']], desc: 'Hide messages from known bots and chat !commands.' },
  { key: 'chatEmotes',     label: 'Emotes',       vals: [['images', 'Images'], ['text', 'Text']], desc: 'Show emotes as their real images, or just their names as text.' },
  { key: 'chatTimestamps', label: 'Timestamps',   bool: true, desc: 'Show the time before each message.' }
];
function chatoptValLabel(row) {
  if (row.bool) return settings[row.key] ? 'On' : 'Off';
  for (var i = 0; i < row.vals.length; i++) if (row.vals[i][0] === settings[row.key]) return row.vals[i][1];
  return '';
}
function openChatOpt() {
  chatopt.open = true; chatopt.focus = 0;
  document.getElementById('chatoptmodal').className = '';
  renderChatOpt();
  touchSettings();
}
function closeChatOpt() {
  chatopt.open = false;
  document.getElementById('chatoptmodal').className = 'hidden';
  if (settings.open) renderSettings();     // refresh the Live chat On/Off pill behind it
}
function renderChatOpt() {
  var list = document.getElementById('chatopt-list');
  list.innerHTML = '';
  CHATOPT_ROWS.forEach(function (row, i) {
    var el = document.createElement('div');
    el.className = 'srow' + (i === chatopt.focus ? ' focused' : '');
    el.setAttribute('data-idx', i);
    var on = !!(row.bool && settings[row.key]);
    var lab = document.createElement('span'); lab.className = 'slabel'; lab.textContent = row.label;
    var pill = document.createElement('span'); pill.className = 'spill' + (on ? ' on' : ''); pill.textContent = chatoptValLabel(row);
    el.appendChild(lab); el.appendChild(pill);
    list.appendChild(el);
  });
  var f = list.children[chatopt.focus];
  if (f) {
    var top = f.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top - 6;
    else if (top + f.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + f.offsetHeight - list.clientHeight + 6;
  }
  showSettingDesc('settings-desc', (CHATOPT_ROWS[chatopt.focus] || {}).desc || '', f);
}
function chatoptMove(delta) { var n = chatopt.focus + delta; if (n < 0 || n >= CHATOPT_ROWS.length) return; chatopt.focus = n; renderChatOpt(); }
function chatoptActivate(dir) {
  dir = dir || 1;
  var row = CHATOPT_ROWS[chatopt.focus];
  if (row.bool) settings[row.key] = !settings[row.key];
  else {
    var idx = 0, n = row.vals.length;
    for (var i = 0; i < n; i++) if (row.vals[i][0] === settings[row.key]) { idx = i; break; }
    settings[row.key] = row.vals[((idx + dir) % n + n) % n][0];
  }
  saveSettings();
  if (row.key === 'chat') syncChat();        // connect/disconnect the chat socket
  applyChatStyle();                          // side/size/width/opacity take effect immediately
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
  if (f) {
    var top = f.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top - 6;
    else if (top + f.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top + f.offsetHeight - list.clientHeight + 6;
  }
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

/* Buffering spinner (live and VOD) and the centre play/pause button (VOD) */
var spinnerOn = false;
function showSpinner() {
  if (spinnerOn) return;
  if (document.getElementById('pbstatus').className.indexOf('hidden') === -1) return;  // reconnecting banner already up
  spinnerOn = true;
  document.getElementById('spinner').className = '';
  hideVodPlay();
}
function hideSpinner() {
  if (!spinnerOn) return;
  spinnerOn = false;
  document.getElementById('spinner').className = 'hidden';
  if (state.vod && document.getElementById('overlay').className.indexOf('hidden') === -1) showVodPlay();
}
function vodPlayIcon() {
  var paused = document.getElementById('video').paused;
  document.getElementById('vodplay-icon').setAttribute('d', paused ? 'M8 5v14l11-7z' : 'M6 5h4v14H6zM14 5h4v14h-4z');
}
function showVodPlay() {
  if (!state.vod || spinnerOn) return;
  vodPlayIcon();
  document.getElementById('vodplay').className = '';
  document.getElementById('vodback').className = '';
  document.getElementById('vodfwd').className = '';
}
function hideVodPlay() {
  document.getElementById('vodplay').className = 'hidden';
  document.getElementById('vodback').className = 'hidden';
  document.getElementById('vodfwd').className = 'hidden';
}
function toggleVodPlay() {
  if (!state.vod) return;
  if (seekAccum.baseTime !== null) applySeekAccum();   // settle a queued seek before pausing
  var v = document.getElementById('video');
  if (v.paused) playVideo(v); else { try { v.pause(); } catch (e) {} }
  vodPlayIcon();
  showVodOverlay();
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
// The overlay's look (side/size/width/opacity) is carried as classes so the 'on'
// visibility flag can be toggled without losing them.
function chatClassBase() {
  var cls = ['csize-' + settings.chatSize, 'cwidth-' + settings.chatWidth,
             'copacity-' + settings.chatOpacity, 'cbg-' + settings.chatBackground];
  if (settings.chatSide === 'left') cls.push('side-left');
  return cls.join(' ');
}
function showChatOverlay() { chatEl().className = chatClassBase() + ' on'; }
function hideChatOverlay() { chatEl().className = chatClassBase(); }
function applyChatStyle() {
  var el = chatEl();
  var on = el.classList.contains('on');
  el.className = chatClassBase() + (on ? ' on' : '');
}
function clearChat() { chatEl().innerHTML = ''; }
// Bots and !commands are noise on a TV; optionally filter them out.
var CHAT_BOTS = { botrix: 1, nightbot: 1, streamelements: 1, streamlabs: 1, fossabot: 1,
                  wizebot: 1, moobot: 1, kickbot: 1, ohbot: 1 };
function isBotMessage(d) {
  var name = (d.sender && d.sender.username || '').toLowerCase();
  if (CHAT_BOTS[name]) return true;
  return String(d.content || '').replace(/^\s+/, '').charAt(0) === '!';   // chat command
}
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
      chat.retry = 0;               // connected for real: future drops start from a short delay again
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
    if (settings.chatEmotes === 'text') {
      row.appendChild(document.createTextNode(m[2]));   // just the emote name, no image
    } else {
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
    }
    last = re.lastIndex;
  }
  if (last < content.length) row.appendChild(document.createTextNode(content.slice(last)));
}
// Kick tags chatters with badges (broadcaster, mod, sub, VIP, OG...). We show the
// top one or two as small coloured tags before the name, drawn as plain text so
// they render on the TV font (icon glyphs come out as tofu boxes here).
var BADGE_MAP = {
  broadcaster: { label: 'HOST', cls: 'host' },
  moderator:   { label: 'MOD',  cls: 'mod' },
  vip:         { label: 'VIP',  cls: 'vip' },
  og:          { label: 'OG',   cls: 'og' },
  founder:     { label: 'FDR',  cls: 'sub' },
  subscriber:  { label: 'SUB',  cls: 'sub' },
  sub_gifter:  { label: 'GIFT', cls: 'sub' }
};
var BADGE_ORDER = ['broadcaster', 'moderator', 'vip', 'og', 'founder', 'subscriber', 'sub_gifter'];
function badgeChipsFor(sender) {
  var badges = sender && sender.identity && sender.identity.badges;
  if (!badges || !badges.length) return [];
  var have = {};
  badges.forEach(function (b) { if (b && b.type) have[b.type] = true; });
  var out = [];
  for (var i = 0; i < BADGE_ORDER.length && out.length < 2; i++) {
    if (have[BADGE_ORDER[i]]) out.push(BADGE_MAP[BADGE_ORDER[i]]);
  }
  return out;
}
function addChatMessage(d) {
  if (!d || !d.sender) return;
  if (settings.chatBots === 'hide' && isBotMessage(d)) return;
  var box = chatEl();
  var row = document.createElement('div');
  row.className = 'cmsg';
  if (settings.chatTimestamps) {
    var ts = document.createElement('span'); ts.className = 'ctime';
    var dt = new Date();
    ts.textContent = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2) + ' ';
    row.appendChild(ts);
  }
  badgeChipsFor(d.sender).forEach(function (c) {
    var b = document.createElement('span');
    b.className = 'cbadge ' + c.cls;
    b.textContent = c.label;
    row.appendChild(b);
  });
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
  // let each message fade out and drop off after a while, so the overlay does not
  // build up into a static wall of text ('Never' / 0 keeps them until they scroll off)
  if (settings.chatFade > 0) {
    setTimeout(function () {
      row.classList.add('cfade');
      setTimeout(function () { if (row.parentNode) row.parentNode.removeChild(row); }, 800);
    }, settings.chatFade);
  }
}

/* OLED burn-in guard.
   Static bright pixels can burn into an OLED over time. When nothing has moved
   for a while and the screen is showing something static (an idle message or a
   paused frame), we heavily dim the whole panel so nothing stays lit and bright.
   Any remote or pointer activity wakes it back up. */
var saver = { on: false, timer: null };
function markInput() {
  state.lastInput = Date.now();
  if (saver.on) wakeSaver();
  touchSettings();
}
function isStaticScreen() {
  var v = document.getElementById('video');
  // a VOD is moving video too, so only an idle screen or a paused frame counts
  return (!state.current && !state.vod) || (v && v.paused);
}
function checkSaver() {
  if (!state.ready || saver.on || state.notifyCurrent || !settings.saverMin) return; // 0 = guard off
  if (Date.now() - state.lastInput > settings.saverMin * 60000 && isStaticScreen()) showSaver();
}
function showSaver() { saver.on = true; document.getElementById('saver').className = 'on'; }
function wakeSaver() { saver.on = false; document.getElementById('saver').className = ''; }

/* Live-channels popup (Channel Up/Down): a quick surf list of the channels that
   are live right now. It never appears when nothing is live. OK plays the
   highlighted one; it auto-hides after a few seconds. */
var chpop = { open: false, list: [], idx: 0, timer: null, persistent: false };
var chpopPreviewCard = makePreviewCard('chpoppreview',
  function () { return chpop.open ? chpop.list[chpop.idx] : null; },
  function (e) {
    var box = document.getElementById('chpop-list');
    var row = box.children[chpop.idx];
    var top = 400;
    if (row) {
      var r = row.getBoundingClientRect();
      top = Math.max(90, Math.min(1080 - 280, r.top - 60));
    }
    e.style.top = Math.round(top) + 'px';
  });
function liveList() {
  var out = [];
  state.order.forEach(function (s) { if (state.channels[s] && state.channels[s].live) out.push(s); });
  return out;
}
function chpopMove(dir) {
  chpop.persistent = false;                 // the user is here — normal auto-hide applies again
  var live = liveList();
  if (!live.length) return;                 // nothing live: do not show
  if (!chpop.open) {
    chpop.open = true;
    showCursor();
    document.getElementById('chpop').className = '';
    chpop.list = live;
    var ci = state.current ? live.indexOf(state.current) : -1;
    chpop.idx = ci >= 0 ? ci : 0;
    prefetchSidePreviews();               // warm thumbnails for the surf list too
  } else {
    chpop.list = live;
    if (chpop.idx >= live.length) chpop.idx = live.length - 1;
  }
  var n = chpop.idx + dir;
  if (n < 0) n = live.length - 1;
  else if (n >= live.length) n = 0;
  chpop.idx = n;
  renderChpop();
  resetChpopTimer();
}
function renderChpop() {
  var box = document.getElementById('chpop-list');
  box.innerHTML = '';
  chpop.list.forEach(function (slug, i) {
    var c = state.channels[slug] || {};
    var row = document.createElement('div');
    row.className = 'chrow' + (isChannelBlocked(c) ? ' blocked' : '') +
                    (i === chpop.idx ? ' focused' : '');
    row.setAttribute('data-idx', i);
    var av = document.createElement('div');
    av.className = 'chav';
    if (c.avatar) av.style.backgroundImage = 'url(' + c.avatar + ')';
    else av.textContent = (c.name || slug).charAt(0).toUpperCase();
    row.appendChild(av);
    var mid = document.createElement('div');
    mid.className = 'chmid';
    mid.innerHTML = '<div class="chname"></div><div class="chgame"></div>';
    mid.children[0].textContent = c.name || slug;
    mid.children[1].textContent = (c.category || 'Live') + (c.title ? ' · ' + c.title : '');
    row.appendChild(mid);
    var vw = document.createElement('span');
    vw.className = 'chview';
    vw.innerHTML = '<span class="chdot"></span>';
    vw.appendChild(document.createTextNode(fmtViewers(c.viewers || 0)));
    row.appendChild(vw);
    box.appendChild(row);
  });
  var el = box.children[chpop.idx];
  if (el) {
    var top = el.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top - 6;
    else if (top + el.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = top + el.offsetHeight - box.clientHeight + 6;
  }
  chpopPreviewCard.update();
}
function chpopActivate() {
  var slug = chpop.list[chpop.idx];
  closeChpop();
  if (slug && slug !== state.current) { closeSidebar(); play(slug); }   // same channel: just close
}
function closeChpop() {
  chpop.open = false;
  chpop.persistent = false;
  clearTimeout(chpop.timer);
  chpopPreviewCard.cancel();
  document.getElementById('chpop').className = 'hidden';
}
function resetChpopTimer() {
  if (chpop.persistent) return;        // the stream-end popup waits for the user
  clearTimeout(chpop.timer);
  chpop.timer = setTimeout(closeChpop, 4500);
}
// Opened when a stream ends with nothing auto-advancing: stays up until the
// user acts, and the 30s poll keeps its list fresh (they might be away).
function openChpopPersistent() {
  var live = liveList();
  if (!live.length || chpop.open || !state.ready) return;
  chpop.open = true;
  chpop.persistent = true;
  showCursor();
  document.getElementById('chpop').className = '';
  chpop.list = live;
  chpop.idx = 0;
  prefetchSidePreviews();
  renderChpop();
  clearTimeout(chpop.timer);           // no auto-hide
}
function refreshChpopList() {
  var live = liveList();
  if (!live.length) {                  // everyone went offline while they were away
    closeChpop();
    if (!state.current && !state.vod) showNothing();
    return;
  }
  var focused = chpop.list[chpop.idx];
  chpop.list = live;
  var fi = live.indexOf(focused);
  chpop.idx = fi >= 0 ? fi : 0;
  renderChpop();
}
function isChUp(k) { return k === 33 || k === 427; }
function isChDown(k) { return k === 34 || k === 428; }

/* One balloon, shared by anything that wants to explain itself on hover. */
function showTip(text, anchor) {
  var tip = document.getElementById('browse-tip');
  if (!tip || !anchor) return;
  tip.textContent = text;
  tip.className = '';
  var r = anchor.getBoundingClientRect();
  var left = Math.max(24, Math.min(1920 - tip.offsetWidth - 24,
                                   r.left + r.width / 2 - tip.offsetWidth / 2));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(r.bottom + 14) + 'px';
}
function hideTip() {
  var tip = document.getElementById('browse-tip');
  if (tip) tip.className = 'hidden';
}

/* Small helpers */
function toast(msg) {
  dimToastShowing = false;   // a new toast replaces the dim popup; dimQuickKey re-flags its own
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.style.filter = popupDimFilter();
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
  if (!state.ready) {                               // still on the splash, ignore input until data is ready
    e.preventDefault();
    // ...except the way out. disableBackHistoryAPI means we own the Back key, so
    // swallowing it here would leave no escape if boot ever stalls.
    if (k === KEY.BACK || k === KEY.STOP) armOrExit();
    return;
  }
  if (k !== KEY.BACK && k !== KEY.STOP) state.quitArmed = false; // anything but Back cancels a pending exit
  if (cats.open) {
    var csearch = document.getElementById('cats-search');
    if (document.activeElement === csearch) {          // typing in the search box
      if (k === KEY.BACK || k === KEY.OK) { e.preventDefault(); csearch.blur(); }
      return;                                          // let the on-screen keyboard type
    }
    e.preventDefault();
    if (k === KEY.BACK || k === KEY.YELLOW) closeCats();
    else if (k === KEY.LEFT) catsMove(-1, 0);
    else if (k === KEY.RIGHT) catsMove(1, 0);
    else if (k === KEY.UP) catsMove(0, -1);
    else if (k === KEY.DOWN) catsMove(0, 1);
    else if (k === KEY.OK) catsActivate();
    else if (k === KEY.GREEN) {                       // green pins/unpins the focused category
      if (cats.gridIdx > 0 && displayedCats()[cats.gridIdx - 1]) {
        var pc = displayedCats()[cats.gridIdx - 1];
        toggleCatPin(pc.slug, pc.name || pc.slug);
      }
    }
    else if (k === KEY.RED) {                         // red blocks or unblocks the focused category
      if (cats.gridIdx > 0 && displayedCats()[cats.gridIdx - 1]) {
        var bcat = displayedCats()[cats.gridIdx - 1];
        var nowBlocked = toggleCatBlock(bcat.slug, bcat.name || bcat.slug);
        toast((nowBlocked ? 'Blocked ' : 'Unblocked ') + (bcat.name || bcat.slug));
        applyBlockedChange();
      }
    }
    return;
  }
  if (browse.open) {
    e.preventDefault();
    if (k === KEY.BLUE || k === KEY.BACK) closeBrowse();
    else if (k === KEY.YELLOW) openCats();               // yellow opens the categories picker
    else if (k === KEY.GREEN) cycleBrowseSort();         // green cycles the sort order
    else if (k === KEY.LEFT) browseMove(-1, 0);
    else if (k === KEY.RIGHT) browseMove(1, 0);
    else if (k === KEY.UP) browseMove(0, -1);
    else if (k === KEY.DOWN) browseMove(0, 1);
    else if (k === KEY.OK) browseActivate();
    return;
  }
  if (vods.open) {
    e.preventDefault();
    if (k === KEY.YELLOW || k === KEY.BACK) closeVods();
    else if (k === KEY.GREEN) toggleVodHideWatched();    // green hides/shows watched videos
    else if (k === KEY.LEFT) vodMove(-1, 0);
    else if (k === KEY.RIGHT) vodMove(1, 0);
    else if (k === KEY.UP) vodMove(0, -1);
    else if (k === KEY.DOWN) vodMove(0, 1);
    else if (k === KEY.OK) vodActivate();
    return;
  }
  if (updateopen) {
    e.preventDefault();
    var notes = document.getElementById('update-notes');
    if (k === KEY.UP) notes.scrollTop -= 120;
    else if (k === KEY.DOWN) notes.scrollTop += 120;
    else if (k === KEY.BACK || k === KEY.OK || k === KEY.LEFT) closeUpdateNotes();
    return;
  }
  if (qualityopt.open) {
    e.preventDefault();
    if (k === KEY.BACK || k === KEY.LEFT) closeQualityOpt();
    else if (k === KEY.UP) qualityoptMove(-1);
    else if (k === KEY.DOWN) qualityoptMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) qualityoptActivate();
    return;
  }
  if (dimopt.open) {
    e.preventDefault();
    if (k === KEY.BACK) closeDimOpt();
    else if (k === KEY.UP) dimoptMove(-1);
    else if (k === KEY.DOWN) dimoptMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) dimoptActivate(1);
    else if (k === KEY.LEFT) dimoptActivate(-1);
    return;
  }
  if (chatopt.open) {
    e.preventDefault();
    if (k === KEY.BACK) closeChatOpt();
    else if (k === KEY.UP) chatoptMove(-1);
    else if (k === KEY.DOWN) chatoptMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) chatoptActivate(1);
    else if (k === KEY.LEFT) chatoptActivate(-1);
    return;
  }
  if (blockedcats.open) {
    e.preventDefault();
    if (k === KEY.BACK) closeBlockedCats();
    else if (k === KEY.UP) blockedcatsMove(-1);
    else if (k === KEY.DOWN) blockedcatsMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) blockedcatsActivate();
    return;
  }
  if (settings.open) {
    e.preventDefault();
    if (k === KEY.BACK || k === KEY.RED) closeSettings();   // red toggles it shut (left now adjusts)
    else if (k === KEY.UP) settingsMove(-1);
    else if (k === KEY.DOWN) settingsMove(1);
    else if (k === KEY.OK) settingsOk();
    else if (k === KEY.RIGHT) settingsActivate(); // Right operates the row's primary toggle/cycle only
    else if (k === KEY.LEFT) {                  // left mirrors right: toggle, or previous choice
      var lit = settings.items[settings.focus];
      if (lit && lit.kind === 'choice') { cycleChoice(lit, -1); renderSettings(); }
      else settingsActivate();
    }
    return;
  }
  if (chpop.open) {
    e.preventDefault();
    if (isChUp(k) || k === KEY.UP) chpopMove(-1);
    else if (isChDown(k) || k === KEY.DOWN) chpopMove(1);
    else if (k === KEY.OK) chpopActivate();
    else if (k === KEY.BACK || k === KEY.LEFT || k === KEY.RIGHT) closeChpop();
    return;
  }
  if (state.mode === 'add') {
    if (k === KEY.BACK) { e.preventDefault(); if (add.zone === 'list') backToInput(); else closeAdd(); }
    else if (k === KEY.OK) { e.preventDefault(); confirmAdd(); }
    else if (add.zone === 'input' && k === KEY.DOWN && add.results.length) { e.preventDefault(); enterAddList(); }
    else if (add.zone === 'list' && k === KEY.UP) { e.preventDefault(); addNav(-1); }
    else if (add.zone === 'list' && k === KEY.DOWN) { e.preventDefault(); addNav(1); }
    return; // otherwise let the on-screen keyboard do the typing
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
  if (k === KEY.N0) { dimQuickKey(); return; }         // 0 toggles dim; press again within 3s to change strength
  if (k === KEY.BLUE) { openBrowse(); return; }        // blue opens the live browser
  if (k === KEY.RED) { openSettings(); return; }       // red opens settings
  if (k === KEY.YELLOW) { openVodsForContext(); return; } // yellow opens past videos
  if (isChUp(k)) { chpopMove(-1); return; }            // channel up/down surf the live list
  if (isChDown(k)) { chpopMove(1); return; }
  if (k === KEY.OK && state.notifyCurrent) { activateNotify(); return; }
  if (k === KEY.REW) { if (state.vod) seekVod(-60); return; }
  if (k === KEY.FF) { if (state.vod) seekVod(60); return; }
  if (state.sidebarOpen) {
    resetIdle();
    // The bottom player tools are pointer-only: hovering highlights them, but
    // the D-pad always drives the channel list. Left/Right consistently tucks
    // the sidebar away, never cycles the tools.
    if (state.playerToolFocus >= 0) setPlayerToolFocus(-1);
    if (k === KEY.UP) moveSide(-1);
    else if (k === KEY.DOWN) moveSide(1);
    else if (k === KEY.OK) activateSide();               // OK (or a click) opens the highlighted channel
    else if (k === KEY.GREEN) refreshSide();             // green button refreshes the list
    else if (k === KEY.LEFT || k === KEY.RIGHT) closeSidebar();   // either side tucks the list away
    else if (k === KEY.BACK) closeSidebarWithGrace();
    return;
  }
  if (state.vod) {                                       // watching a past video
    if (k === KEY.BACK || k === KEY.STOP) { exitVod(); return; }
    if (k === KEY.LEFT || k === KEY.RIGHT) { openSidebar(); return; }
    if (k === KEY.UP) { chpopMove(-1); return; }         // up/down surf live channels
    if (k === KEY.DOWN) { chpopMove(1); return; }
    if (k === KEY.PAUSE) { try { video.pause(); } catch (e2) {} return; }
    if (k === KEY.PLAY) { playVideo(video); return; }
    if (k === KEY.OK) { showVodOverlay(); return; }
    return;
  }
  if (k === KEY.BACK || k === KEY.STOP) { armOrExit(); return; }
  if (k === KEY.LEFT || k === KEY.RIGHT) openSidebar();  // left or right brings the list up
  else if (k === KEY.UP) chpopMove(-1);                 // up/down surf the live channels
  else if (k === KEY.DOWN) chpopMove(1);
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
  document.getElementById('notify').addEventListener('click', function (e) {
    e.stopPropagation();
    activateNotify();
  });
  playerEl.addEventListener('click', function (e) {
    if (!state.ready || state.mode !== 'player') return;
    if (e.target.id === 'video' || e.target === playerEl || e.target.id === 'idle') {
      if (state.sidebarOpen) {
        closeSidebarWithGrace();                                  // do not reopen on the next stray move
      } else {
        state.suppressNudgeUntil = 0;                               // an explicit click always brings it back
        openSidebar();
      }
    }
  });
  // Moving the pointer opens the sidebar, which then hides itself after a few idle seconds.
  var lastX = -1, lastY = -1;
  playerEl.addEventListener('mousemove', function (e) {
    if (diagDrag) return;                 // dragging the diagnostics window, not browsing
    if (!state.ready || state.mode !== 'player') return;
    if (lastX >= 0 && Math.abs(e.clientX - lastX) < 6 && Math.abs(e.clientY - lastY) < 6) return;
    lastX = e.clientX; lastY = e.clientY;
    showCursor();      // a real move brings the pointer back
    if (!state.sidebarOpen && Date.now() < state.suppressNudgeUntil) return;   // click-to-hide grace
    nudgeSidebar();
    if (state.vod) showVodOverlay();               // reveal the VOD seek bar
  });
  document.getElementById('side-refresh').addEventListener('click', function (e) {
    e.stopPropagation();
    if (state.mode === 'player') refreshSide();
  });
  var favList = document.getElementById('fav-list');
  favList.addEventListener('mouseover', function (e) {
    resetIdle();
    hideQualityHint();
    if (state.playerToolFocus >= 0) setPlayerToolFocus(-1);
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
    if (state.mode !== 'add') return;
    var q = document.getElementById('addinput').value.trim();
    if (q) addChannelBySlug(q);          // the Add button adds exactly what was typed
  });
  document.getElementById('addcancel').addEventListener('click', function () {
    if (state.mode === 'add') closeAdd();
  });
  document.getElementById('addmodal').addEventListener('click', function (e) {
    if (state.mode === 'add' && e.target === this) closeAdd();
  });
  document.getElementById('addinput').addEventListener('input', function () {
    if (state.mode === 'add') scheduleLiveSearch();
  });
  var aresults = document.getElementById('addresults');
  function aResultIdx(e) {
    var el = e.target;
    while (el && el !== aresults && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === aresults) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= add.results.length) ? -1 : i;
  }
  aresults.addEventListener('mouseover', function (e) {
    var i = aResultIdx(e);
    if (i >= 0 && i !== add.focus) { add.zone = 'list'; add.focus = i; applyAddFocus(); }
  });
  aresults.addEventListener('click', function (e) {
    var i = aResultIdx(e);
    if (i >= 0) { add.focus = i; selectAddResult(); }
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
      toggleBrowseLang(parseInt(el.getAttribute('data-idx'), 10));
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
    if (browseGrid.scrollTop + browseGrid.clientHeight >= browseGrid.scrollHeight - 500) {
      if (browse.renderLimit < browse.streams.length) { browse.renderLimit += 40; renderBrowse(); }
      loadBrowseMore(false);
    }
  });
  document.getElementById('browse-close').addEventListener('click', function () { closeBrowse(); });
  var catsBtn = document.getElementById('browse-cats-btn');
  if (catsBtn) catsBtn.addEventListener('click', function (e) { e.stopPropagation(); openCats(); });
  document.getElementById('browse-sort').addEventListener('click', function (e) { e.stopPropagation(); cycleBrowseSort(); });
  document.getElementById('browse-discover').addEventListener('click', function (e) { e.stopPropagation(); toggleBrowseDiscover(); });
  // Balloon tip explaining what Discover does.
  document.getElementById('browse-discover').addEventListener('mouseenter', function () {
    showTip('Hides channels you already follow, so Browse only shows new finds.', this);
  });
  document.getElementById('browse-discover').addEventListener('mouseleave', hideTip);
  document.getElementById('vods-filter').addEventListener('click', function (e) { e.stopPropagation(); toggleVodHideWatched(); });
  // The x on the diagnostics panel switches the overlay off.
  document.getElementById('diag-close').addEventListener('click', function (e) {
    e.stopPropagation();
    settings.diagnostics = false;
    saveSettings();
    syncDiagnostics();
    if (settings.open) renderSettings();
    toast('Diagnostics off');
  });
  // The whole diagnostics panel is a drag handle: grab anywhere, park anywhere.
  document.getElementById('diagnostics').addEventListener('mousedown', function (e) {
    if (e.target.id === 'diag-close') return;
    var r = this.getBoundingClientRect();
    diagDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    diagManualPos = true;
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!diagDrag) return;
    var el = document.getElementById('diagnostics');
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(0, Math.min(1920 - w, e.clientX - diagDrag.dx));
    var top = Math.max(0, Math.min(1080 - h, e.clientY - diagDrag.dy));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', function () { diagDrag = null; });
  // Pinned category chips above the grid.
  document.getElementById('browse-pinnedcats').addEventListener('click', function (e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-x')) {   // the ✕ unpins instead of selecting
      e.stopPropagation();
      var pchip = t.parentNode;
      toggleCatPin(pchip.getAttribute('data-cslug'), pchip.getAttribute('data-cname'));
      return;
    }
    var el = t;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-cslug') != null)) el = el.parentNode;
    if (!el || el === this) return;
    e.stopPropagation();
    var cslug = el.getAttribute('data-cslug');
    selectCategory(cslug || null, el.getAttribute('data-cname') || '');
  });
  // Categories popup pointer
  var catsGrid = document.getElementById('cats-grid');
  function catCardIdx(e) {
    var el = e.target;
    while (el && el !== catsGrid && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === catsGrid) return -2;
    var list = catsGrid.children;
    for (var i = 0; i < list.length; i++) if (list[i] === el) return i;
    return -2;
  }
  catsGrid.addEventListener('mouseover', function (e) {
    var i = catCardIdx(e);
    if (i >= 0 && i !== cats.gridIdx) { cats.gridIdx = i; applyCatsFocus(); }
    // mouseenter does not bubble, so the badge tip rides on the grid's mouseover
    var t = e.target;
    while (t && t !== catsGrid && !(t.getAttribute && t.getAttribute('data-act') === 'catblock')) t = t.parentNode;
    if (t && t !== catsGrid) {
      showTip('Blocked categories drop to the bottom of your channel list, greyed out, and stop showing live alerts.', t);
    } else hideTip();
  });
  catsGrid.addEventListener('mouseout', function (e) {
    if (!e.relatedTarget || !catsGrid.contains(e.relatedTarget)) hideTip();
  });
  catsGrid.addEventListener('click', function (e) {
    var be = e.target;    // the block badge blocks instead of selecting
    while (be && be !== catsGrid && !(be.getAttribute && be.getAttribute('data-act') === 'catblock')) be = be.parentNode;
    if (be && be !== catsGrid) {
      e.stopPropagation();
      var bidx = catCardIdx(e);
      if (bidx > 0 && displayedCats()[bidx - 1]) {
        var bcat2 = displayedCats()[bidx - 1];
        var nb = toggleCatBlock(bcat2.slug, bcat2.name || bcat2.slug);
        toast((nb ? 'Blocked ' : 'Unblocked ') + (bcat2.name || bcat2.slug));
        applyBlockedChange();
      }
      return;
    }
    var pe = e.target;    // the pin badge toggles instead of selecting
    while (pe && pe !== catsGrid && !(pe.getAttribute && pe.getAttribute('data-act') === 'catpin')) pe = pe.parentNode;
    if (pe && pe !== catsGrid) {
      e.stopPropagation();
      var pidx = catCardIdx(e);
      if (pidx > 0 && displayedCats()[pidx - 1]) {
        var pcat = displayedCats()[pidx - 1];
        toggleCatPin(pcat.slug, pcat.name || pcat.slug);
      }
      return;
    }
    var i = catCardIdx(e);
    if (i >= 0) { cats.gridIdx = i; catsActivate(); }
  });
  catsGrid.addEventListener('wheel', function (e) {
    if (!cats.open) return;
    e.preventDefault();
    catsGrid.scrollTop += (e.deltaY > 0 ? 1 : -1) * 160;
    if (catsGrid.scrollTop + catsGrid.clientHeight >= catsGrid.scrollHeight - 400) loadCatsMore(false);
  });
  document.getElementById('cats-close').addEventListener('click', function () { closeCats(); });
  document.getElementById('cats-search').addEventListener('input', function () {
    if (!cats.open) return;
    var q = this.value.trim();
    cats.query = q;
    clearTimeout(catsSearchTimer);
    if (!q) {                                  // cleared: back to the paginated list
      cats.results = null;
      cats.gridIdx = 0;
      renderCats();
      setCatsStatus(cats.list.length ? '' : 'Loading...');
      return;
    }
    catsSearchTimer = setTimeout(function () { runCatsSearch(q); }, 250);
  });
  // Past videos popup pointer
  var vodsGrid = document.getElementById('vods-grid');
  function vodCardIdx(e) {
    var el = e.target;
    while (el && el !== vodsGrid && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === vodsGrid) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= vods.list.length) ? -1 : i;
  }
  vodsGrid.addEventListener('mouseover', function (e) {
    var i = vodCardIdx(e);
    if (i >= 0 && i !== vods.gridIdx) { vods.gridIdx = i; applyVodFocus(); }
  });
  vodsGrid.addEventListener('click', function (e) {
    var i = vodCardIdx(e);
    if (i >= 0) { vods.gridIdx = i; vodActivate(); }
  });
  vodsGrid.addEventListener('wheel', function (e) {
    if (!vods.open) return;
    e.preventDefault();
    vodsGrid.scrollTop += (e.deltaY > 0 ? 1 : -1) * 160;
  });
  document.getElementById('vods-close').addEventListener('click', function () { closeVods(); });
  // Drag (or click) the VOD seek track to scrub. While dragging we preview the
  // position on the bar and only seek the video on release, so it stays smooth.
  var vodTrack = document.getElementById('vodbar-track');
  function vodTrackFrac(e) {
    var r = vodTrack.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  }
  function vodPreview(e) {
    var v = document.getElementById('video');
    if (isFinite(v.duration) && v.duration) drawVodBar(vodTrackFrac(e) * v.duration, v.duration);
  }
  vodTrack.addEventListener('mousedown', function (e) {
    if (!state.vod) return;
    vodDragging = true;
    clearTimeout(overlayTimer);                 // keep the bar visible while dragging
    document.getElementById('vodbar').className = '';
    vodPreview(e);
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (vodDragging) vodPreview(e);
  });
  document.addEventListener('mouseup', function (e) {
    if (vodDragging) { vodDragging = false; seekVodFrac(vodTrackFrac(e)); }
  });
  // Dedicated player tools: stream quality and Settings stay separate.
  var settingsButton = document.getElementById('settings-button');
  if (settingsButton) {
    settingsButton.addEventListener('mouseenter', function () {
      hideQualityHint();
      if (state.playerToolFocus !== 1) setPlayerToolFocus(1);
      resetIdle();
    });
    settingsButton.addEventListener('click', function (e) {
      e.stopPropagation(); setPlayerToolFocus(1); openSettings();
    });
  }
  var qualityButton = document.getElementById('quality-button');
  if (qualityButton) {
    qualityButton.addEventListener('mouseenter', function () {
      if (state.playerToolFocus !== 0) setPlayerToolFocus(0);
      resetIdle();
      showQualityHint();
    });
    qualityButton.addEventListener('mouseleave', function () { hideQualityHint(); });
    qualityButton.addEventListener('click', function (e) {
      e.stopPropagation(); setPlayerToolFocus(0); openQualityOpt();
    });
  }
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
  slist.addEventListener('wheel', function (e) {
    if (!settings.open) return;
    e.preventDefault();
    settingsMove(e.deltaY > 0 ? 1 : -1);
  });
  slist.addEventListener('click', function (e) {
    var i = sRowIdx(e);
    if (i < 0) return;
    settings.focus = i; applySettingsFocus();
    var g = e.target, onGear = false;      // clicking the Dim gear opens its options
    while (g && g !== this) {
      var cl = g.getAttribute && g.getAttribute('class');
      if (cl && cl.indexOf('sgear') !== -1) { onGear = true; break; }
      g = g.parentNode;
    }
    if (onGear) {
      var git = settings.items[i];
      if (git && git.kind === 'chatopt') openChatOpt(); else openDimOpt();
    } else settingsActivate();
  });
  document.getElementById('settingsmodal').addEventListener('click', function (e) {
    if (e.target === this) closeSettings();
  });
  // The version chip opens the release notes when an update is available
  document.getElementById('settings-ver').addEventListener('click', function (e) {
    e.stopPropagation();
    if (updateInfo) openUpdateNotes();
  });
  // The bottom colour-button legend is clickable too.
  document.getElementById('cbguide').addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-act'))) el = el.parentNode;
    if (!el || el === this) return;
    var act = el.getAttribute('data-act');
    if (act === 'settings') openSettings();
    else if (act === 'refresh') refreshSide();
    else if (act === 'vods') openVodsForContext();
    else if (act === 'browse') openBrowse();
    else if (act === 'dim') dimQuickKey();
  });
  // The category chip in the top bar opens Browse filtered to that category.
  document.getElementById('ov-title').addEventListener('click', function (e) {
    var el = e.target;
    if (!(el.getAttribute && el.getAttribute('data-catslug'))) return;
    e.stopPropagation();
    if (!state.ready || state.mode !== 'player') return;
    openBrowse(el.getAttribute('data-catslug'), el.textContent);
  });
  // Mini home screen: Continue Watching card + live-favorite tiles.
  document.getElementById('home-resume-row').addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-vid'))) el = el.parentNode;
    if (!el || el === this) return;
    e.stopPropagation();
    closeSidebar();
    openSavedVod(el.getAttribute('data-slug'), el.getAttribute('data-vid'));
  });
  document.getElementById('home-live-row').addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-slug'))) el = el.parentNode;
    if (!el || el === this) return;
    e.stopPropagation();
    var slug = el.getAttribute('data-slug');
    if (state.channels[slug] && state.channels[slug].live) { closeSidebar(); play(slug); }
  });
  // VOD centre play/pause button and the -30/+30 skip buttons beside it
  document.getElementById('vodplay').addEventListener('click', function (e) { e.stopPropagation(); toggleVodPlay(); });
  document.getElementById('vodback').addEventListener('click', function (e) { e.stopPropagation(); if (state.vod) seekVod(-30); });
  document.getElementById('vodfwd').addEventListener('click', function (e) { e.stopPropagation(); if (state.vod) seekVod(30); });
  // Dim options popup pointer
  var dimoptList = document.getElementById('dimopt-list');
  function dimoptIdx(e) {
    var el = e.target;
    while (el && el !== dimoptList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === dimoptList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) ? -1 : i;
  }
  dimoptList.addEventListener('mouseover', function (e) { var i = dimoptIdx(e); if (i >= 0 && i !== dimopt.focus) { dimopt.focus = i; renderDimOpt(); } });
  dimoptList.addEventListener('click', function (e) { var i = dimoptIdx(e); if (i >= 0) { dimopt.focus = i; dimoptActivate(); } });
  document.getElementById('dimoptmodal').addEventListener('click', function (e) { if (e.target === this) closeDimOpt(); });
  // Chat options popup pointer
  var chatoptList = document.getElementById('chatopt-list');
  function chatoptIdx(e) {
    var el = e.target;
    while (el && el !== chatoptList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === chatoptList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) ? -1 : i;
  }
  chatoptList.addEventListener('mouseover', function (e) { var i = chatoptIdx(e); if (i >= 0 && i !== chatopt.focus) { chatopt.focus = i; renderChatOpt(); } });
  chatoptList.addEventListener('click', function (e) { var i = chatoptIdx(e); if (i >= 0) { chatopt.focus = i; chatoptActivate(); } });
  document.getElementById('chatoptmodal').addEventListener('click', function (e) { if (e.target === this) closeChatOpt(); });
  // Blocked categories popup pointer
  var blockedcatsList = document.getElementById('blockedcats-list');
  function blockedcatsIdx(e) {
    var el = e.target;
    while (el && el !== blockedcatsList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === blockedcatsList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    // the link row sits one past the last entry, so it is a valid index here
    return (isNaN(i) || i < 0 || i > blockedcatsLinkIndex()) ? -1 : i;
  }
  blockedcatsList.addEventListener('mouseover', function (e) {
    var i = blockedcatsIdx(e);
    if (i >= 0 && i !== blockedcats.focus) { blockedcats.focus = i; renderBlockedCats(); }
  });
  blockedcatsList.addEventListener('click', function (e) {
    var i = blockedcatsIdx(e);
    if (i >= 0) { blockedcats.focus = i; blockedcatsActivate(); }
  });
  document.getElementById('blockedcatsmodal').addEventListener('click', function (e) {
    if (e.target === this) closeBlockedCats();
  });
  // Stream quality picker pointer
  var qualityoptList = document.getElementById('qualityopt-list');
  function qualityoptIdx(e) {
    var el = e.target;
    while (el && el !== qualityoptList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === qualityoptList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= qualityopt.items.length) ? -1 : i;
  }
  qualityoptList.addEventListener('mouseover', function (e) {
    var i = qualityoptIdx(e);
    if (i >= 0 && i !== qualityopt.focus) { qualityopt.focus = i; renderQualityOpt(); }
  });
  qualityoptList.addEventListener('click', function (e) {
    var i = qualityoptIdx(e);
    if (i >= 0) { qualityopt.focus = i; qualityoptActivate(); }
  });
  document.getElementById('qualityoptmodal').addEventListener('click', function (e) {
    if (e.target === this) closeQualityOpt();
  });
  // Update-available release notes popup
  document.getElementById('update-close').addEventListener('click', function () { closeUpdateNotes(); });
  document.getElementById('updatemodal').addEventListener('click', function (e) { if (e.target === this) closeUpdateNotes(); });
  // Live-channels surf popup pointer
  var chpopList = document.getElementById('chpop-list');
  function chRowIdx(e) {
    var el = e.target;
    while (el && el !== chpopList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === chpopList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= chpop.list.length) ? -1 : i;
  }
  chpopList.addEventListener('mouseover', function (e) {
    var i = chRowIdx(e);
    if (i >= 0 && i !== chpop.idx) { chpop.idx = i; renderChpop(); resetChpopTimer(); }
  });
  chpopList.addEventListener('click', function (e) {
    var i = chRowIdx(e);
    if (i >= 0) { chpop.idx = i; chpopActivate(); }
  });
  // Clicking the dimmed area outside the panel closes the surf popup, so a click
  // never falls through to the sidebar and leaves the popup stuck open.
  document.getElementById('chpop').addEventListener('click', function (e) {
    if (e.target === this) closeChpop();
  });
  // A pointer move anywhere counts as activity for the burn-in guard.
  document.addEventListener('mousemove', function () { markInput(); });
  document.addEventListener('mousedown', function () { markInput(); });
  document.addEventListener('wheel', function () { markInput(); });
})();

/* Watching the video element for trouble */
(function wireVideo() {
  var video = document.getElementById('video');
  video.addEventListener('error', function () {
    if (state.vod) { reloadVod(); return; }
    if (PB.active && state.current) recoverPlayback(state.current);
  });
  video.addEventListener('ended', function () {
    // A queued ended task from a source we just replaced must not complete or
    // skip the new VOD (or be mistaken for the newly resumed live channel).
    if (!video.ended) return;
    if (state.vod) {
      if (state.vod.completed || state.vod.ending) return;
      state.vod.ending = true;
      completeVodProgress();
      advanceVodOrExit();
      return;
    }
    if (PB.active && state.current) handleEnded(state.current);   // detect a finished live stream
  });
  video.addEventListener('playing', function () {
    PB.stallCount = 0; PB.netRetries = 0; PB.mediaRetries = 0; setBanner('');
    if (state.vod) state.vod.mediaRecoveries = 0;   // recovered for real, forget the failures
    hideSpinner();
  });
  // Buffering spinner for both live and VOD.
  video.addEventListener('waiting', function () { if (!video.paused) showSpinner(); });
  video.addEventListener('seeking', function () { showSpinner(); });
  video.addEventListener('loadedmetadata', function () { if (state.vod) applyVodResume(); });
  video.addEventListener('durationchange', function () { if (state.vod) applyVodResume(); });
  video.addEventListener('canplay', function () { if (state.vod) applyVodResume(); hideSpinner(); });
  video.addEventListener('timeupdate', function () {
    if (state.vod) saveVodProgress(false);
    else saveLiveMark(false);
  });
  video.addEventListener('seeked', function () {
    hideSpinner();
    if (state.vod) saveVodProgress(true);
  });
  // Keep the VOD play/pause icon in sync with the actual state.
  video.addEventListener('play', function () { if (state.vod) vodPlayIcon(); });
  video.addEventListener('pause', function () {
    if (state.vod) { saveVodProgress(true); vodPlayIcon(); hideSpinner(); }
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
        if (!state.current && !state.vod) {
          if (state.netDown) showNothing();
          else retryLastVodAfterReconnect();
        }
        if (state.netDown && !state.current) loop(); else state.downRetry = false;
      });
    }, 8000);
  })();
}

/* Startup */
document.addEventListener('visibilitychange', function () {
  if (document.hidden) { saveVodProgress(true); saveLiveMark(true); pauseNotify(); return; }
  fetchFavorites(function () {
    if (state.sidebarOpen) renderSidebar();
    if (state.ready && !state.current && !state.vod) {
      if (state.netDown) showNothing();
      else retryLastVodAfterReconnect();
    }
  });
  if (PB.active && state.current) { PB.recoverCount = 0; recoverPlayback(state.current); } // a deliberate check, not a failure
  pumpNotify();
});
window.addEventListener('pagehide', function () { saveVodProgress(true); saveLiveMark(true); });
// Handle the network coming back or dropping out.
window.addEventListener('online', function () {
  fetchFavorites(function () {
    if (state.sidebarOpen) renderSidebar();
    if (state.ready && !state.current && !state.vod) {
      if (state.netDown) showNothing();
      else retryLastVodAfterReconnect();
    }
  });
  if (PB.active && state.current) { PB.recoverCount = 0; recoverPlayback(state.current); }
  else if (state.netDown) scheduleDownRetry();
});
window.addEventListener('offline', function () {
  setNetDown(true);
  if (state.sidebarOpen) renderSidebar();
});
// The startup live chain is explicit rather than relying on sidebar sort order:
// last successful live stream, first live pin, then the first other live stream.
function startupLiveTarget() {
  var last = loadLast();
  var c, slug;
  if (last && state.order.indexOf(last) !== -1) {
    c = state.channels[last];
    if (c && c.live && c.playbackUrl) return last;
  }
  for (var i = 0; i < state.order.length; i++) {
    slug = state.order[i]; c = state.channels[slug];
    if (c && c.live && c.playbackUrl && !isChannelBlocked(c) && isPinned(slug)) return slug;
  }
  for (var j = 0; j < state.order.length; j++) {
    slug = state.order[j]; c = state.channels[slug];
    if (c && c.live && c.playbackUrl && !isChannelBlocked(c)) return slug;
  }
  return null;
}
// A saved VOD contains only a channel slug and stable recording id. Resolve it
// through Kick on every launch so deleted/gated recordings fall through and
// expiring HLS URLs are never restored from localStorage.
function resumeLastVodAtStartup(done) {
  var marker = loadLastVod();
  if (!marker) { done(false, false); return; }
  // If none of the favorite lookups could reach Kick, the VOD lookup cannot
  // succeed either. Keep the marker and show the offline screen immediately.
  if (state.netDown) { done(false, true); return; }
  document.getElementById('idle-load').className = '';
  serviceGet('/api/v2/channels/' + encodeURIComponent(marker.slug) + '/videos', function (err, data) {
    document.getElementById('idle-load').className = 'hidden';
    var currentMarker = loadLastVod();
    if (!currentMarker || currentMarker.slug !== marker.slug || currentMarker.id !== marker.id) {
      done(false, false);
      return;
    }
    // This matters for a reconnect retry, when input is already enabled. A
    // user-selected stream must always beat a late VOD-list response.
    if (state.ready && (state.current || state.vod || startupRecoveryUiBusy())) {
      done(false, true);
      return;
    }
    if (err) {
      if (err === 404 || err === '404') clearLastVod();
      done(false, !(err === 404 || err === '404'));
      return;
    }
    if (!Array.isArray(data)) { done(false, true); return; }
    var list = data.filter(playableVod);
    var index = -1;
    for (var i = 0; i < list.length; i++) {
      if (vodStableId(list[i]) === marker.id) { index = i; break; }
    }
    if (index < 0) {
      clearLastVod();
      done(false, false);
      return;
    }
    if (!state.channels[marker.slug]) {
      state.channels[marker.slug] = offlineStub(marker.slug);
      state.channels[marker.slug].name = marker.name || marker.slug;
    }
    vods.slug = marker.slug;
    vods.list = list;
    vods.gridIdx = index;
    state.vodReturn = startupLiveTarget();
    playVod(list[index], list.slice(), index, marker.slug);
    done(true, false);
  });
}
function startupRecoveryUiBusy() {
  return document.hidden || state.mode !== 'player' || state.sidebarOpen || saver.on ||
    browse.open || vods.open || cats.open || chpop.open || settings.open ||
    dimopt.open || chatopt.open || blockedcats.open || qualityopt.open || updateopen;
}
function retryLastVodAfterReconnect() {
  if (!state.ready || state.current || state.vod || state.netDown || state.vodRecoveryInFlight) return;
  if (!loadLastVod()) { showNothing(); return; }
  if (startupRecoveryUiBusy()) {
    clearTimeout(state.vodRecoveryRetryTimer);
    state.vodRecoveryRetryTimer = setTimeout(retryLastVodAfterReconnect, 1000);
    return;
  }
  state.vodRecoveryInFlight = true;
  resumeLastVodAtStartup(function (resumed, retryable) {
    state.vodRecoveryInFlight = false;
    if (resumed || state.current || state.vod) return;
    if (retryable && startupRecoveryUiBusy()) {
      clearTimeout(state.vodRecoveryRetryTimer);
      state.vodRecoveryRetryTimer = setTimeout(retryLastVodAfterReconnect, 1000);
      return;
    }
    var target = startupLiveTarget();
    if (target) play(target, retryable); else showNothing();
  });
}
function finishStartupWithoutVod(preserveLastVod) {
  // The last watched channel may be one you don't follow (opened from Browse).
  // It is not in the favorites data, so look it up directly and give it the
  // same "last watched wins" priority a followed channel gets.
  var last = loadLast();
  if (last && state.order.indexOf(last) === -1 && !state.netDown) {
    apiGet(last, function (err, raw) {
      if (state.current || state.vod) return;        // something else started meanwhile
      if (!err && raw) {
        var c = normalize(last, raw);
        state.channels[last] = c;
        if (c.live && c.playbackUrl) { play(last, preserveLastVod); return; }
      }
      finishStartupFallback(preserveLastVod);        // offline or gone: the usual chain
    });
    return;
  }
  finishStartupFallback(preserveLastVod);
}
function finishStartupFallback(preserveLastVod) {
  var target = startupLiveTarget();
  if (target) { play(target, preserveLastVod); return; }
  // Nothing to play. On a fresh, empty setup, open the live browser so there
  // is something to pick from right away; otherwise show the idle screen.
  if (!getFavorites().length && !state.netDown) {
    showState('empty');
    openBrowse();
  } else {
    showNothing();
    if (state.netDown) scheduleDownRetry();
  }
}
// Try to get video on screen from a single ~50ms request — the saved VOD
// marker or the last watched channel — instead of waiting ~2s for the full
// favorites refresh. Calls done(false) to fall back to the favorites-based
// startup decision.
function quickStart(done) {
  var marker = loadLastVod();
  if (marker) {
    resumeLastVodAtStartup(function (resumed) { done(!!resumed); });
    return;
  }
  var last = loadLast();
  if (!last) { done(false); return; }
  apiGet(last, function (err, raw) {
    if (state.current || state.vod) { done(true); return; }
    if (!err && raw) {
      var c = normalize(last, raw);
      state.channels[last] = c;
      if (c.live && c.playbackUrl) { play(last, false, raw); done(true); return; }   // no refetch
    }
    done(false);
  });
}
// The favorites fetch bounds each request but not the whole pass, and the splash
// ignores every key, so a congested Luna bus could otherwise hold the app for
// minutes. Boot therefore has its own deadline: once it expires we accept input
// and show the idle screen from cached data, and the fetch keeps filling in behind.
var BOOT_DEADLINE_MS = 8000;
var bootDeadlineTimer = null;
// Becomes interactive exactly once, whichever path gets here first.
function markBootReady() {
  if (state.ready) return false;
  clearTimeout(bootDeadlineTimer);
  bootDeadlineTimer = null;
  state.ready = true;
  startPlayerPoll();
  return true;
}
// True once the viewer (or the deadline's idle screen) owns what is on screen, so
// a late startup decision must not yank them somewhere else.
function bootChoiceSuperseded() {
  return !!(state.current || state.vod || state.sidebarOpen || state.mode !== 'player' ||
            browse.open || vods.open || cats.open || chpop.open);
}
(function boot() {
  setMode('player');
  loadQualityPref();
  loadSettings();
  loadChannelCache();                         // instant sidebar/home data while the real fetch runs
  applyDim();
  applyChatStyle();                           // set the chat overlay's side/size/width/opacity
  syncDiagnostics();
  loadAppVersion();                           // populate the version chip in Settings promptly
  setTimeout(checkForUpdate, 3000);           // check GitHub for a newer release, once the app has settled
  state.lastInput = Date.now();
  setInterval(checkSaver, 20000);             // burn-in guard checks in every 20s
  showState('splash');
  // The quick start goes onto the Luna bus FIRST (its single request must not
  // queue behind the favorites pool); the full refresh follows right behind
  // and loads the other channels while playback is already starting.
  bootDeadlineTimer = setTimeout(function () {
    if (!markBootReady()) return;
    showNothing();                            // cached channels give the idle screen something to show
  }, BOOT_DEADLINE_MS);
  var favoritesDone = false, favoritesWaiters = [];
  quickStart(function (started) {
    if (started) {
      markBootReady();
      return;
    }
    var decide = function () {                // nothing quick-startable: wait for real data
      resumeLastVodAtStartup(function (resumed, retryable) {
        var firstReady = markBootReady();     // startup choice is settled; accept input now
        if (resumed) return;
        // If the deadline already handed control over, only finish the startup
        // choice when the viewer has not picked something themselves meanwhile.
        if (!firstReady && bootChoiceSuperseded()) return;
        finishStartupWithoutVod(retryable);
      });
    };
    if (favoritesDone) decide(); else favoritesWaiters.push(decide);
  });
  fetchFavorites(function () {
    favoritesDone = true;
    // a quick-started VOD could not know where to return to before this
    if (state.vod && !state.vodReturn) state.vodReturn = startupLiveTarget();
    for (var i = 0; i < favoritesWaiters.length; i++) favoritesWaiters[i]();
    favoritesWaiters = [];
  });
})();
