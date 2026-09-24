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
  backOpenedSidebar: false,  // Back brought the channel list up, so Back again arms the exit

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
// The follow list exists only here, so a value that will not read back as a list
// is set aside under '<key>.corrupt' before anything can write over it. The next
// add or remove then starts clean without destroying the only copy.
function lsGet(key) {
  var raw = null;
  try { raw = localStorage.getItem(key); } catch (e) { return []; }
  if (raw === null) return [];
  var val;
  try { val = JSON.parse(raw); } catch (e) { val = undefined; }
  if (Array.isArray(val)) return val;
  if (val === null) return [];
  try { localStorage.setItem(key + '.corrupt', raw); } catch (e) {}
  return [];
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  if (key === 'kicktv.added' || key === 'kicktv.removed') favoritesMemo = null;
}
var favoritesMemo = null, favoritesMembership = Object.create(null);
function getFavorites() {
  if (favoritesMemo) return favoritesMemo.slice();
  var removed = lsGet('kicktv.removed'), added = lsGet('kicktv.added'), favs = [];
  SEED_FAVORITES.forEach(function (s) { if (removed.indexOf(s) === -1) favs.push(s); });
  added.forEach(function (s) {
    if (favs.indexOf(s) === -1 && removed.indexOf(s) === -1) favs.push(s);
  });
  favoritesMemo = favs;
  favoritesMembership = Object.create(null);
  favs.forEach(function (slug) { favoritesMembership[slug] = true; });
  return favs.slice();
}
function isFavorite(slug) { if (!favoritesMemo) getFavorites(); return favoritesMembership[slug] === true; }
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
function serviceTransport(path, cb, options) {
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
    bridge.call('luna://com.barisahmet.kicktv.service/fetch', JSON.stringify({ path: path, compact: !(options && options.compact === false) }));
  } catch (e) {
    if (!done) { done = true; clearTimeout(timer); cb('callfail'); }
  }
  return function () {
    done = true; clearTimeout(timer);
    if (bridge.cancel) { try { bridge.cancel(); } catch (e) {} }
  };
}
if (window.UIWork) UIWork.setTransport(serviceTransport);
function serviceGet(path, cb, options) {
  options = { priority: options && options.priority, compact: !(options && options.compact === false) };
  return window.UIWork ? UIWork.request(path, cb, options) : serviceTransport(path, cb, options);
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
function apiGet(slug, cb, options) {
  options = options || { priority: 0 };
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
      }, options);
    }, 700);
  }, options);
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
function logError(e) { try { console.error(e && e.stack ? e.stack : e); } catch (x) {} }
// Only channels that have been fetched at least once can be sorted or shown.
function currentFavoritesWithData() {
  return getFavorites().filter(function (s) { return !!state.channels[s]; });
}
function fetchFavorites(done, liveOnly) {
  done = done || function () {};
  if (fetchInFlight) {
    if (!fetchFollowUp) fetchFollowUp = [];
    fetchFollowUp.push(done);          // wants data fresher than the pass underway
    return;
  }
  fetchInFlight = true;
  runFetchFavorites(function () {
    fetchInFlight = false;             // first, so a throwing callback can never wedge refreshes
    try { done(); } catch (e) { logError(e); }
    prepareSidebarSoon();
    warmPreviews(false);               // newly live channels get a frame within the minute
    var queued = fetchFollowUp;
    fetchFollowUp = null;
    if (queued && queued.length) {
      fetchFavorites(function () {     // follow-up passes are always full
        for (var i = 0; i < queued.length; i++) { try { queued[i](); } catch (e) { logError(e); } }
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
  var focusItem = state.sidebarOpen && state.sideItems[state.sideFocus];
  function targetRank(s) {
    return s === state.current ? 0 : (focusItem && focusItem.slug === s ? 1 :
      (isPinned(s) ? 2 : (state.channels[s] && state.channels[s].live ? 3 : 4)));
  }
  targets = targets.slice().sort(function (a, b) {
    return targetRank(a) - targetRank(b);
  });
  function onOne(slug, err, raw) {
    var stale = gen !== fetchGeneration;
    if (!err && !(raw && typeof raw === 'object')) err = 'parse';   // an empty body must not throw in normalize
    // Whatever one channel's data does, the pass must still count it as finished;
    // otherwise fetchInFlight stays set and the list silently never refreshes again.
    try {
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
    } catch (e) {
      logError(e);
      if (!stale && !state.channels[slug]) state.channels[slug] = offlineStub(slug);
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
      // Sort what the list is NOW, not what it was when this pass began: a remove
      // or pin made mid-pass must not be undone by the pass finishing.
      var favsNow = currentFavoritesWithData();
      try { sortOrder(favsNow); detectOnline(favsNow); saveChannelCache(); }
      finally { done(); }
    } else {
      pump();                          // a slot freed up — start the next one
    }
  }
  function pump() {
    while (started < total && (started - finished) < FETCH_CONCURRENCY) {
      (function (slug) { apiGet(slug, function (err, raw) { onOne(slug, err, raw); },
        { priority: !state.ready || state.sidebarOpen ? 1 : 2 }); })(targets[started++]);
    }
  }
  pump();
}
function setNetDown(down) { state.netDown = down; }
// Watch for a channel going from offline to live and show a small alert. The
// first load just records who is live, so channels that were already on when
// you opened the app do not all pop up at once.
function detectOnline(favs) {
  var newly = [], liveNow = [];
  favs.forEach(function (slug) {
    var c = state.channels[slug];
    if (!c) return;
    if (c.live) liveNow.push(slug);
    if (state.baselineSet && c.live && state.wasLive[slug] === false) {
      // respect the Live alerts setting: All, Pinned only, or Off
      if (settings.alerts === 'all' || (settings.alerts === 'pinned' && isPinned(slug))) {
        newly.push({ slug: slug, name: c.name });
      }
    }
    state.wasLive[slug] = c.live;
  });
  noteLive(liveNow);              // one write per poll, not one per channel
  state.baselineSet = true;
  if (newly.length) notifyOnline(newly);
}
function alertAllowed(item) {
  if (!item || settings.alerts === 'off' || !isFavorite(item.slug)) return false;
  var c = state.channels[item.slug];
  if (!c || !c.live) return false;
  if (item.slug === state.current) return false;   // already watching it
  if (isChannelBlocked(c)) return false;   // a blocked category never interrupts
  return settings.alerts === 'all' || (settings.alerts === 'pinned' && isPinned(item.slug));
}
// Every panel or popup that takes over the remote. This is the ONE list: the
// "is something in the way" checks below all build on it, so a new popup only
// has to be added here and they cannot drift apart again.
function anyPanelOpen() {
  return !!(browse.open || vods.open || cats.open || chpop.open || settings.open || dimopt.open ||
    chatopt.open || blockedcats.open || (qualityopt && qualityopt.open) || updateopen);
}
function notifyUiBusy() {
  return document.hidden || saver.on || !state.ready || state.mode !== 'player' || state.sidebarOpen ||
    anyPanelOpen();
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
  var ch = state.channels[item.slug];
  var el = document.getElementById('notify');
  el.innerHTML = '';
  // Read the avatar now rather than off the queued item, so a channel that sat in the
  // queue for a while still shows whatever picture the last poll saw. The green ring
  // around it carries the "live" colour the old dot used to.
  var av = document.createElement('span');
  av.className = 'nav';
  if (ch && ch.avatar) av.style.backgroundImage = 'url(' + ch.avatar + ')';
  else av.textContent = (item.name || '?').charAt(0).toUpperCase();
  el.appendChild(av);
  el.appendChild(document.createTextNode(item.name + ' is online'));
  var hint = document.createElement('span');
  hint.className = 'nhint';
  hint.textContent = 'Press OK to watch';
  el.appendChild(hint);
  el.style.filter = settings.dim && settings.dimScope !== 'all' ? popupDimFilter() : '';
  el.className = 'show';
  clearTimeout(state.notifyTimer);
  state.notifyTimer = setTimeout(expireNotify, settings.notifySec * 1000);
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
  else if (mode === 'available') { big = ''; sub = ''; }   // the Live now row already says it
  else { big = 'No one is live right now'; sub = 'Open the menu to see your channels'; }
  var msg = document.getElementById('idle-msg');
  msg.innerHTML = '';
  if (!big && !sub) { msg.className = 'hidden'; return; }   // nothing to say; leave the space
  msg.className = '';
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
  hideLiveBar();
  PB.active = false;
  hideVodBar();
  hideSpinner();
  hideVodPlay();
  document.getElementById('player').removeAttribute('data-vod');
  stopWatchdog();
  if (PB.reconnectTimer) { clearTimeout(PB.reconnectTimer); PB.reconnectTimer = null; }
  var video = document.getElementById('video');
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  setPosterStill(null);           // before load(), so nothing stale is left showing
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
}
function returnToIdle() {
  teardownVideo();
  state.current = null;
  state.vod = null; state.vodReturn = null;
  applyStreamerChatPreferences();
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
  applyStreamerChatPreferences();
  state.preserveLastVodDuringLive = !!preserveLastVod;
  // if it is not one of your channels, it shows in the sidebar as a temporary row
  state.tempChannel = !isFavorite(slug) ? slug : null;
  PB.slug = slug; PB.session = (PB.session || 0) + 1; PB.reloading = false; PB.netRetries = 0; PB.mediaRetries = 0;
  PB.recoverCount = 0; PB.endedCount = 0; PB.reconnects = 0; PB.lastError = ''; PB.netWaits = 0;
  PB.userSeekUntil = 0; PB.rewound = false;
  setBanner('');
  showState('hidden');
  updateGear();
  loadChannel(slug, false, prefetchedRaw);
}
// A playback link carries a signed token that Kick issues for about ten minutes.
// Read its expiry, and treat it as usable only with a margin left.
function playbackUrlFresh(url) {
  var m = /[?&]token=([^&]+)/.exec(url || '');
  if (!m) return false;
  try {
    var body = m[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var exp = JSON.parse(atob(body)).exp;
    return typeof exp === 'number' && exp * 1000 - Date.now() > 90000;
  } catch (e) { return false; }
}
// The last started live link, so a relaunch within its lifetime can start at once.
function rememberPlayback(slug, url) {
  try { localStorage.setItem('kicktv.lastplay', JSON.stringify({ slug: slug, url: url })); } catch (e) {}
}
function recallPlayback(slug) {
  try {
    var v = JSON.parse(localStorage.getItem('kicktv.lastplay'));
    return v && v.slug === slug && playbackUrlFresh(v.url) ? v.url : null;
  } catch (e) { return null; }
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
      if (isRecovery) {
        // A lookup that could not reach Kick says nothing about the stream, so it
        // does not spend the give-up budget: keep trying, backing off, until the
        // network comes back. Only a real answer ("not live", 404) ends playback.
        if (err !== 404) PB.recoverCount = Math.max(0, PB.recoverCount - 1);
        // About ten minutes of backoff without one answer: hand over to the idle
        // "Can't reach Kick" screen, whose own retry picks things up again.
        if (err !== 404 && (PB.netWaits || 0) >= 20) {
          toast('Could not reconnect');
          returnToIdle();
          setNetDown(true);
          showNothing();
          scheduleDownRetry();
          return;
        }
        scheduleReconnect(slug, err !== 404);
        return;
      }
      toast('Kick API unreachable');
      returnToIdle();
      return;
    }
    var c = normalize(slug, raw);
    state.channels[slug] = c;
    start(c);
  }
  function start(c) {
    if (!c.live || !c.playbackUrl) { advanceOrIdle(slug); return; }   // stream ended / offline
    PB.netWaits = 0;
    if (!isRecovery) rememberPlayback(slug, c.playbackUrl);
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
  // The list refresh already holds a playback link for every live channel. While
  // its token has time left, start on it and skip the lookup (a round trip to Kick
  // on every switch). If the stream ended meanwhile, recovery looks it up afresh.
  var known = state.channels[slug];
  if (!isRecovery && known && known.live && playbackUrlFresh(known.playbackUrl)) { start(known); return; }
  apiGet(slug, handle, { priority: 0 });
}
/* Show a still while the first frame is decoding, instead of black. Live uses the
   warmed preview thumbnail; a recording uses its own. Cleared on teardown so a
   stale image never sits over the next thing that plays. */
// isAvatar keeps a small profile picture at its own size: an avatar blown up to
// fill 1920x1080 is a mess of pixels, whereas a stream thumbnail is meant to cover.
// Two independent layers, either of which may be null. A stream frame fills the panel.
// The avatar goes on the inner element, which can be round and carry the orbiting loader
// rather than being stretched flat. Given BOTH, the frame becomes a dimmed backdrop and
// the avatar rides on top — you get context and a progress indicator at the same time.
// With neither, the whole layer goes away.
function setPosterStill(frameUrl, avatarUrl) {
  var el = document.getElementById('poster');
  var av = document.getElementById('poster-av');
  if (!el) return;
  if (!frameUrl && !avatarUrl) {
    el.className = 'hidden';
    el.style.backgroundImage = '';
    if (av) av.style.backgroundImage = '';
    return;
  }
  el.style.backgroundImage = frameUrl ? 'url(' + frameUrl + ')' : '';
  if (av) av.style.backgroundImage = avatarUrl ? 'url(' + avatarUrl + ')' : '';
  // 'avatar' lights the circle and starts its arcs; 'framed' dims the frame behind them
  el.className = avatarUrl ? (frameUrl ? 'avatar framed' : 'avatar') : '';
}

// Both, when both exist: a warmed frame as the backdrop and the avatar over it. A frame
// alone still beats black, and the avatar alone still beats black.
function livePoster(slug) {
  var c = previewCache[slug];
  var ch = state.channels[slug];
  return {
    frame: (c && Date.now() - c.t < 3 * PREVIEW_REFRESH_MS) ? c.url : null,
    avatar: (ch && ch.avatar) || null
  };
}
function attachStream(slug, url) {
  var video = document.getElementById('video');
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  PB.netRetries = 0; PB.mediaRetries = 0;
  PB.userSeekUntil = 0; PB.rewound = false;
  liveWatchStartedMs = Date.now();   // a fresh live session to mark
  liveMarkLastWrite = 0;
  liveWatchCountedMs = liveWatchStartedMs;
  liveWatchAccumSec = 0;
  liveWatchSeeded = false;           // re-fold the stored total on the next save
  liveWatchContentMs = 0;
  var lp = livePoster(slug);
  setPosterStill(lp.frame, lp.avatar);
  try { video.playbackRate = 1; } catch (e) {}
  if (window.Hls && Hls.isSupported()) {
    var hls = new Hls(hlsConfig());
    state.hls = hls;
    qualityAlertReset();
    hls.on(Hls.Events.ERROR, function (ev, data) {
      if (data && data.details) PB.lastError = data.details;
      if (state.hls !== hls || !data || !data.fatal) return;   // old stream, or not fatal, so ignore
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) onNetworkError(slug, hls, data.details);
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) onMediaError(slug, hls, data.details);
      else recoverPlayback(slug);                              // nothing we can patch, reload it all
    });
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      if (state.hls !== hls) return;                           // a newer stream took over
      applyQualityPref();                                      // honour the saved quality choice
      if (qualityopt && qualityopt.open) refreshQualityOpt();
    });
    if (Hls.Events.LEVEL_SWITCHED) {
      hls.on(Hls.Events.LEVEL_SWITCHED, function () {
        if (state.hls === hls) { updateQualityButton(); checkQualityDrop(); }
      });
    }
    if (Hls.Events.FRAG_LOADED) {
      hls.on(Hls.Events.FRAG_LOADED, function (ev, d) { diagCountFrag(d); });
    }
    // hls.js starts a live stream at its sync point, which usually lands partway
    // into a segment. The TV's decoder then has to run from that segment's
    // keyframe to the point before it shows anything, and waits for several more
    // segments while it does: measured, 3s to the first frame instead of ~1.2s.
    // Starting at the segment's own start costs at most one segment of extra
    // delay, which Auto chat delay absorbs.
    var aligned = false;
    hls.on(Hls.Events.FRAG_BUFFERED, function (ev, d) {
      if (aligned || state.hls !== hls) return;
      aligned = true;
      var f = d && d.frag, t = video.currentTime;
      if (f && t > f.start + 0.2 && t < f.start + f.duration) video.currentTime = f.start + 0.05;
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
var resumeWasPaused = false;   // unused while the pause-under-popups experiment is in
/* EXPERIMENT — playback keeps running under the popups.
   These used to pause the video and stop the loader so a popup stayed smooth on
   the TV's limited decode budget. Both are now no-ops so the stream continues
   behind Browse and Past videos. Revert this commit to restore the old behaviour. */
function pausePlaybackForBrowse() {}
function resumePlaybackAfterBrowse() {}
function onNetworkError(slug, hls, details) {
  if (state.current !== slug) return;
  // After a fatal manifest error hls.js has no levels, so startLoad() is a no-op
  // and only a fresh playback link (the old one usually expired) gets us back.
  if (details && String(details).indexOf('manifest') === 0) { recoverPlayback(slug); return; }
  PB.netRetries++;
  if (PB.netRetries <= MAX_NET_RETRY) {
    setBanner('Reconnecting...');
    try { hls.startLoad(); } catch (e) { recoverPlayback(slug); }
  } else {
    recoverPlayback(slug);                        // retried enough, the link probably expired, get a new one
  }
}
function onMediaError(slug, hls, details) {
  if (state.current !== slug) return;
  // hls.js decides which SourceBuffers to create from the first fragment it parses. Some
  // Kick streams begin with an audio-only segment, so it makes an audio buffer and no video
  // one — and MSE will not let a video buffer be added afterwards. Every video fragment
  // then fails to append forever. recoverMediaError() cannot help, because nothing is wrong
  // with the buffer contents; the buffer set itself is wrong. Only a new MediaSource fixes
  // it, and since the live edge keeps moving the next attempt usually lands on a segment
  // that carries video. Measured on a stream that reproduced it: four of six attempts came
  // up with both tracks.
  if (details === 'bufferAppendError') { recoverPlayback(slug); return; }
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
    if (err && err !== 404) { PB.endedCount = 0; scheduleReconnect(slug, true); return; }
    var live = !err && raw && raw.livestream && raw.livestream.is_live && raw.playback_url;
    if (!live) { advanceOrIdle(slug); return; }
    state.channels[slug] = normalize(slug, raw);
    attachStream(slug, raw.playback_url);
  });
}
// netWait: the last try could not reach Kick at all. Those retries back off
// (5s, 10s, 20s, then every 30s) instead of hammering a dead link.
function scheduleReconnect(slug, netWait) {
  setBanner('Reconnecting...');
  if (PB.reconnectTimer) return;
  var wait = 5000;
  if (netWait) {
    PB.netWaits = (PB.netWaits || 0) + 1;
    wait = Math.min(30000, 5000 * Math.pow(2, PB.netWaits - 1));
  }
  PB.reconnectTimer = setTimeout(function () {
    PB.reconnectTimer = null;
    if (state.current === slug) recoverPlayback(slug);
  }, wait);
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
    var quiet = !state.sidebarOpen && !chpop.open && !browse.open && !cats.open && !vods.open;
    // Closed menus need much less directory work. Keep live alerts current on
    // a two-minute beat; a movie with alerts disabled needs no directory poll.
    if (quiet) {
      if (state.vod && settings.alerts === 'off') return;
      if (playerPollTick % 4 !== 0) return;
    }
    // Open menus use a full pass every90s with live-only checks between.
    // Quiet checks include offline channels too, so new-live alerts work.
    fetchFavorites(function () {
      if (state.sidebarOpen) renderSidebar();
      if (chpop.open && chpop.persistent) refreshChpopList();   // keep the stream-end list fresh
      if (!state.current) { if (state.ready) showNothing(); return; }
      var cur = state.channels[state.current];
      if (cur) {
        var ov = document.getElementById('overlay');
        if (ov.className.indexOf('hidden') === -1) fillOverlay(cur);
      }
    }, !quiet && playerPollTick % 3 !== 0);
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
  vodOverlayKey = '';
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
  showLiveBar(false);
  armLiveOverlayHide();
}
function armLiveOverlayHide() {
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(function () {
    if (state.sidebarOpen) return;                     // with the sidebar open it hides on close instead
    // still seeking, or the pointer is resting on the bar
    if (liveSeek.base !== null || liveBar.dragTarget !== null || liveBar.hover || catPop.hover) { armLiveOverlayHide(); return; }
    document.getElementById('overlay').className = 'hidden';
    hideLiveBar();
  }, liveBar.focused ? 6000 : 4000);
}
/* Block the playing category from the top bar. Resting the pointer on the category
   chip opens a small "Block category" button under it; the bar stays up while the
   pointer is on either, and a short grace lets the pointer cross the gap. */
var catPop = { hover: false, timer: null, slug: '', name: '' };
function showCatPop(chip) {
  var pop = document.getElementById('ovcat-pop'), ov = document.getElementById('overlay');
  if (!pop || !ov) return;
  clearTimeout(catPop.timer);
  catPop.hover = true;
  catPop.slug = chip.getAttribute('data-catslug');
  catPop.name = chip.textContent;
  var blocked = isCatBlocked(catPop.slug);
  pop.innerHTML = blockIcon();
  pop.appendChild(document.createTextNode(blocked ? 'Unblock category' : 'Block category'));
  pop.className = blocked ? 'unblock' : '';
  var r = chip.getBoundingClientRect(), o = ov.getBoundingClientRect();
  pop.style.left = Math.round(r.left - o.left) + 'px';
  pop.style.top = Math.round(r.bottom - o.top + 10) + 'px';
}
function leaveCatPop() {
  clearTimeout(catPop.timer);
  catPop.timer = setTimeout(hideCatPop, 250);
}
function hideCatPop() {
  clearTimeout(catPop.timer);
  catPop.hover = false;
  var pop = document.getElementById('ovcat-pop');
  if (pop && pop.className !== 'hidden') pop.className = 'hidden';
}
// OK on a live stream: the info bar comes up with the timeline focused, so
// Left/Right seek; OK again (or Back) puts it all away.
function toggleOverlay() {
  var ov = document.getElementById('overlay');
  if (ov.className === 'hidden') {
    var c = state.channels[state.current];
    if (c) { liveBar.focused = true; showOverlay(c); }
  } else if (liveSeek.base !== null) applyLiveSeek();
  else if (!liveBar.focused && liveBarVisible()) {   // up from a channel switch: take the timeline
    liveBar.focused = true;
    showOverlay(state.channels[state.current]);
  }
  else { ov.className = 'hidden'; clearTimeout(overlayTimer); hideLiveBar(); }
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
  if (open) endQualityAlert();
  if (tools) { if (open) tools.classList.remove('hidden'); else if (!tools.classList.contains('qalert')) tools.classList.add('hidden'); }
  if (!open) {
    state.playerToolFocus = -1;
    hideQualityHint();
  }
  applyPlayerToolFocus();
  updateQualityButton();
  var guide = document.getElementById('cbguide');
  if (guide) { if (open) guide.classList.remove('hidden'); else guide.classList.add('hidden'); }
}
var sidebarRevealFrame = null;
function openSidebar() {
  if (!state.ready || browse.open || vods.open || cats.open || chpop.open) return;
  state.suppressNudgeUntil = 0;                  // an explicit reopen cancels an older Back/click grace
  showCursor();
  if (!state.sidebarOpen) {
    state.sidebarOpen = true;
    if (state.notifyCurrent) pauseNotify();
    document.getElementById('sidebar').className = 'open';
    sidePreviewArmed = !state.vod;      // in a VOD, wait for a move or a hover
    var prefer = (state.current && state.order.indexOf(state.current) !== -1)
      ? state.current : null;
    var list = document.getElementById('fav-list');
    if (!list.children.length) renderSidebar(prefer);
    else if (prefer) {
      for (var i = 0; i < state.sideItems.length; i++) {
        if (state.sideItems[i].slug === prefer) { state.sideFocus = i; break; }
      }
      applySideFocus();
    }
  }
  resetIdle();
  updateGear();
  if (sidebarRevealFrame !== null) cancelAnimationFrame(sidebarRevealFrame);
  sidebarRevealFrame = requestAnimationFrame(function () {
    sidebarRevealFrame = requestAnimationFrame(function () {
      sidebarRevealFrame = null;
      if (!state.sidebarOpen) return;
      renderSidebar();
      if (state.current && state.channels[state.current]) showOverlay(state.channels[state.current]);
      placeDiagnostics();
      prefetchSidePreviews();
      if (state.vod) showVodOverlay();
      if (Date.now() - state.lastFetch > 60000) {
        fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(); });
      }
    });
  });
}
function closeSidebar() {
  clearTimeout(state.idleTimer);
  if (vodOverlayFrame !== null) { cancelAnimationFrame(vodOverlayFrame); vodOverlayFrame = null; }
  if (sidebarRevealFrame !== null) { cancelAnimationFrame(sidebarRevealFrame); sidebarRevealFrame = null; }
  if (!state.sidebarOpen) return;
  state.sidebarOpen = false;
  state.backOpenedSidebar = false;   // however this list closed, the exit is no longer armed
  document.getElementById('sidebar').className = '';
  document.getElementById('overlay').className = 'hidden';
  hideLiveBar();
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
  if (state.vod && (vodPointerHover || vodDragging)) return;
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
  armSidePreview();          // a deliberate move is what earns the preview in a VOD
  applySideFocus();
}
/* Moving the highlight.
   The obvious way is to rewrite every child's className and let the right one come out
   focused. That dirties the style of the whole list, and the offsetTop read that follows
   then forces a recalc and layout across all of it — on every D-pad press, and on every
   pointer move that crosses a row. In a deep Browse grid that is hundreds of cards per
   keypress, which is exactly where the user is holding the button down.
   Only two elements ever change: the one losing focus and the one gaining it. These
   helpers touch only those two. The node losing focus is remembered rather than its
   index, because a re-render replaces the children — and a node that is no longer in
   the container does not need clearing, which makes this self-correcting. */
/* Chromium 87 has no string-valued text-overflow, so the trailing dots are done by
   hand — and doing it by hand also fills the box exactly, instead of the browser
   dropping a whole character to make room for a "…". Measuring on a canvas keeps
   it off the layout path; thirty-eight rows measured twice would otherwise be a
   reflow apiece. */
var textMeasureCtx = null;
function measureTextWidth(s, font) {
  if (!textMeasureCtx) textMeasureCtx = document.createElement('canvas').getContext('2d');
  textMeasureCtx.font = font;
  return textMeasureCtx.measureText(s).width;
}
function clipWithDots(text, font, maxPx) {
  text = String(text == null ? '' : text);
  if (maxPx <= 0 || measureTextWidth(text, font) <= maxPx) return text;
  var dots = '..';
  var budget = maxPx - measureTextWidth(dots, font);
  if (budget <= 0) return dots;
  var lo = 0, hi = text.length;                  // longest prefix that still fits
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (measureTextWidth(text.slice(0, mid), font) <= budget) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).replace(/[\s·]+$/, '') + dots;
}
var sideTextStyle = null;
// The sidebar has fixed fonts, so read those once. Widths depend on the row: one with
// a viewer count or pin marker stops short of it. Read every width in one batch
// before writing any text, and only clip a value whose text or width changed. Keep
// the original so refreshing never clips its own dots.
// The second line is two spans, category then " · title", in different fonts. The
// category keeps its room first; the title gets whatever is left.
function clipSidebarText() {
  var list = document.getElementById('fav-list');
  if (!sideTextStyle) {
    var probe = list.querySelector('.favname');
    if (!probe || probe.clientWidth <= 0) return;
    // Finish reading styles before writing any text.
    var fonts = {};
    ['.favname', '.favcat', '.favtitle'].forEach(function (sel) {
      var cs = getComputedStyle(list.querySelector(sel));
      fonts[sel] = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    });
    sideTextStyle = { fonts: fonts };
  }
  var f = sideTextStyle.fonts;
  var names = list.querySelectorAll('.favname'), subs = list.querySelectorAll('.favgame');
  var nameW = [], subW = [], i;
  for (i = 0; i < names.length; i++) nameW.push(names[i].clientWidth);
  for (i = 0; i < subs.length; i++) subW.push(subs[i].clientWidth);
  for (i = 0; i < names.length; i++) {
    var el = names[i], w = nameW[i], full = el.getAttribute('data-full');
    if (w <= 0) continue;
    if (full === null) { full = el.textContent; el.setAttribute('data-full', full); }
    var key = full + '\n' + w;
    if (el._sideClipKey === key) continue;
    var clipped = clipWithDots(full, f['.favname'], w);
    if (el.textContent !== clipped) el.textContent = clipped;
    el._sideClipKey = key;
  }
  for (i = 0; i < subs.length; i++) {
    var sub = subs[i], sw = subW[i];
    if (sw <= 0 || !sub._sideParts) continue;
    var skey = sub.getAttribute('data-full') + '\n' + sw;
    if (sub._sideClipKey === skey) continue;
    clipTwoParts(sub.children[0], sub.children[1], sub._sideParts.cat, sub._sideParts.rest,
      f['.favcat'], f['.favtitle'], sw);
    sub._sideClipKey = skey;
  }
}
function swapFocus(container, prevEl, nextEl, baseOf, wantFocus) {
  if (prevEl && prevEl !== nextEl && prevEl.parentNode === container) {
    var prevClass = baseOf(prevEl);
    if (prevEl.className !== prevClass) prevEl.className = prevClass;
  }
  if (nextEl) {
    var nextClass = baseOf(nextEl) + (wantFocus ? ' focused' : '');
    if (nextEl.className !== nextClass) nextEl.className = nextClass;
  }
  return nextEl;
}
// Keep a focused row in view by the shared rule (revealScroll, virtual-grid.js).
function scrollIntoViewport(container, el, pad) {
  if (!el) return;
  var scroll = container.scrollTop;
  var next = revealScroll(scroll, container.clientHeight, el.offsetTop - container.offsetTop, el.offsetHeight, pad);
  if (next !== scroll) container.scrollTop = next;
}
var sideFocusEl = null;
var sideLayout = null;
// Row sizes do not change on focus or metadata refresh. Read their positions in
// one batch after membership/order changes, before the focus styles are written.
function measureSideLayout(list) {
  var height = list.clientHeight;
  if (!height) { sideLayout = null; return; }
  var origin = list.offsetTop, rows = [];
  for (var i = 0; i < list.children.length; i++) {
    var row = list.children[i];
    rows.push({ top: row.offsetTop - origin, height: row.offsetHeight });
  }
  sideLayout = { height: height, maxScroll: Math.max(0, list.scrollHeight - height), rows: rows };
}
function sideBaseOf(row) { return row.getAttribute('data-base') || 'favrow'; }
function applySideFocus() {
  var list = document.getElementById('fav-list');
  var row = list.children[state.sideFocus] || null;
  if (!sideLayout) measureSideLayout(list);
  var pos = sideLayout && sideLayout.rows[state.sideFocus];
  // Read scrollTop before changing either row's style; wheel scrolling remains
  // the source of truth without remeasuring every row on each keypress.
  var scroll = list.scrollTop, nextScroll = scroll;
  if (pos) {
    nextScroll = revealScroll(scroll, sideLayout.height, pos.top, pos.height, 8);
    if (nextScroll !== scroll) nextScroll = Math.max(0, Math.min(sideLayout.maxScroll, nextScroll));
  }
  sideFocusEl = swapFocus(list, sideFocusEl, row, sideBaseOf, state.playerToolFocus < 0);
  if (nextScroll !== scroll) list.scrollTop = nextScroll;
  if (state.sidebarOpen) scheduleSidePreview();
}
/* Live thumbnail previews. A card shows the stream's current frame beside the
   focused list row — used by the sidebar and the quick-switch popup. The window
   appears instantly with a loading spinner; the frame swaps in when loaded
   (usually at once, thanks to prefetching). */
var previewCache = {};   // slug -> { t, url, bitmap, img, ready }; v1 thumbnails live on images.kick.com, which loads directly
var previewPending = Object.create(null);
var PREVIEW_REFRESH_MS = 60000;   // how old a frame may get before the warmer fetches the next one
/* The preview card's size in device pixels. Read once from the stylesheet (it is
   fixed there) and the screen's pixel ratio, so every frame is scaled to exactly
   what this TV draws — no bigger. */
var previewPx = null;
function previewTargetSize() {
  if (previewPx) return previewPx;
  var e = document.getElementById('sidepreview');
  var cs = e ? getComputedStyle(e) : null;
  var w = cs ? parseFloat(cs.width) : NaN, h = cs ? parseFloat(cs.height) : NaN;
  var radius = cs ? (parseFloat(cs.borderTopLeftRadius) || 0) - (parseFloat(cs.borderTopWidth) || 0) : 10;
  if (!(w > 0) || !(h > 0)) { w = 426; h = 240; }
  var dpr = window.devicePixelRatio || 1;
  previewPx = { w: Math.round(w * dpr), h: Math.round(h * dpr), r: Math.max(0, radius) * dpr };
  return previewPx;
}
// The v2 payload only carries a thumbnail host the webview cannot load, so ask v1
// for the images.kick.com variants and take the smallest that still covers the card.
function pickPreviewUrl(raw) {
  var t = raw && raw.livestream && raw.livestream.thumbnail;
  if (!t) return null;
  return pickSrcsetUrl(t.responsive, previewTargetSize().w) || t.url || null;
}
function previewReady(slug) {
  var c = previewCache[slug];
  return !!(c && c.ready);
}
function releasePreview(entry) {
  if (entry && entry.bitmap && entry.bitmap.close) { try { entry.bitmap.close(); } catch (e) {} }
}
/* Kick's variants come in fixed sizes. Download the one that covers the card, let
   the browser decode it as-is off the main thread (a Blob source decodes on a
   worker), then crop and shrink it to the card's exact pixels with one GPU draw.
   Measured on the TV: createImageBitmap's own resize option stalled every frame for
   ~500ms per image, while a plain decode plus a canvas draw costs no frames at all
   (bar a one-off shader compile on the first). Frames are prepared one at a time so
   a warm pass never lands as a burst. If the blob route fails, the Image is kept
   and scaled at draw time instead. */
var previewPrepQueue = [], previewPrepBusy = false;
function queuePreviewPrep(job) {
  previewPrepQueue.push(job);
  if (!previewPrepBusy) nextPreviewPrep();
}
function nextPreviewPrep() {
  var job = previewPrepQueue.shift();
  if (!job) { previewPrepBusy = false; return; }
  previewPrepBusy = true;
  job(function () { setTimeout(nextPreviewPrep, 50); });
}
function scalePreviewBitmap(full) {
  var size = previewTargetSize(), w = size.w, h = size.h, iw = full.width, ih = full.height;
  var s = Math.max(w / iw, h / ih), sw = w / s, sh = h / s;
  var canvas = window.OffscreenCanvas ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
  if (full.close) full.close();
  return canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : canvas;
}
function loadPreviewFrame(url, done) {
  var settled = false;
  function once(bitmap, img) { if (!settled) { settled = true; done(bitmap, img); } }
  function viaImage() {
    var img = new Image();
    img.onload = function () { once(null, img); };
    img.onerror = function () { once(null, null); };
    img.src = url;
  }
  if (!window.createImageBitmap) { viaImage(); return; }
  var xhr = new XMLHttpRequest();
  try {
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.timeout = 15000;
  } catch (e) { viaImage(); return; }
  xhr.onload = function () {
    if (xhr.status !== 200 || !xhr.response) { viaImage(); return; }
    var blob = xhr.response;
    queuePreviewPrep(function (next) {
      createImageBitmap(blob).then(function (full) {
        var bitmap = null;
        try { bitmap = scalePreviewBitmap(full); } catch (e) { logError(e); }
        next();
        if (bitmap) once(bitmap, null); else viaImage();
      }, function () { next(); viaImage(); });
    });
  };
  xhr.onerror = xhr.ontimeout = viaImage;
  xhr.send();
}
/* Resolve a channel's current frame AND prepare it, then swap it into the cache.
   Each new frame has its own versionId in the URL. Until the new one is ready the
   cache keeps the previous frame, so a card never waits on the network once a
   channel has been warmed. */
// `urgent` is for a frame someone is waiting on (a highlighted row that was not
// warmed yet, a Browse card); the background warmer leaves it off.
function fetchPreviewUrl(slug, done, urgent) {
  if (previewPending[slug]) { if (done) previewPending[slug].push(done); return; }
  previewPending[slug] = done ? [done] : [];
  function finish() {
    var callbacks = previewPending[slug] || [];
    delete previewPending[slug];
    callbacks.forEach(function (callback) { try { callback(); } catch (e) { logError(e); } });
  }
  serviceGet('/api/v1/channels/' + encodeURIComponent(slug), function (err, raw) {
    var url = err ? null : pickPreviewUrl(raw);
    var old = previewCache[slug];
    if (!url) { finish(); return; }
    if (old && old.url === url && old.ready) { old.t = Date.now(); finish(); return; }
    loadPreviewFrame(url, function (bitmap, img) {
      if (bitmap || img) {
        releasePreview(old);
        previewCache[slug] = { t: Date.now(), url: url, bitmap: bitmap, img: img, ready: true };
      } else if (!old) previewCache[slug] = { t: Date.now(), url: url, bitmap: null, img: null, ready: false };
      else old.t = Date.now();          // keep showing the last good frame; retry next round
      finish();
    });
  }, { priority: urgent ? 1 : 3 });  // idle: never ahead of the channel list refresh
}
// Every channel whose frame a list could show: live favourites plus a temporary one.
function previewTargets() {
  var out = [];
  for (var i = 0; i < state.order.length; i++) {
    var c = state.channels[state.order[i]];
    if (c && c.live) out.push(state.order[i]);
  }
  var t = state.tempChannel;
  if (t && state.channels[t] && state.channels[t].live && out.indexOf(t) === -1) out.push(t);
  return out;
}
// Drop frames for channels that went offline or left the list, so the cache stays
// the size of the live list instead of growing through a long evening.
function prunePreviews(keep) {
  for (var slug in previewCache) {
    if (keep.indexOf(slug) === -1 && !previewPending[slug]) { releasePreview(previewCache[slug]); delete previewCache[slug]; }
  }
}
/* Keep every live channel's frame warm in the background, on a one-minute beat,
   so opening the sidebar or surf list shows real frames at once. Stale ones only;
   the request queue runs them two at a time at background priority, behind playback. */
var previewWarmLast = 0;
function warmPreviews(force) {
  if (!state.ready || document.hidden || saver.on) return;
  if (!force && Date.now() - previewWarmLast < PREVIEW_REFRESH_MS - 5000) return;
  previewWarmLast = Date.now();
  var targets = previewTargets();
  prunePreviews(targets);
  // Whatever the viewer is about to look at goes first: the highlighted row, then
  // the list order (pinned and busiest channels are at the top).
  var focusItem = state.sidebarOpen && state.sideItems[state.sideFocus];
  if (focusItem && focusItem.slug && targets.indexOf(focusItem.slug) > 0) {
    targets.splice(targets.indexOf(focusItem.slug), 1);
    targets.unshift(focusItem.slug);
  }
  targets.forEach(function (slug) {
    var cached = previewCache[slug];
    if (!cached || Date.now() - cached.t >= PREVIEW_REFRESH_MS - 5000) fetchPreviewUrl(slug);
  });
}
// Opening a list forces a pass over anything stale (the timer may be up to a
// minute away); fresh frames are left alone, so this costs nothing when warm.
function prefetchSidePreviews() { warmPreviews(true); }
setInterval(function () { warmPreviews(false); }, PREVIEW_REFRESH_MS);
// Copy a prepared frame onto the card's canvas, clipped to the card's inner
// rounded corners (a canvas is not clipped by its parent's border-radius).
function drawPreviewFrame(card, entry) {
  var size = previewTargetSize();
  var canvas = card.querySelector('canvas.prevframe');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'prevframe';
    card.insertBefore(canvas, card.firstChild);
  }
  if (canvas.width !== size.w || canvas.height !== size.h) { canvas.width = size.w; canvas.height = size.h; }
  var ctx = canvas.getContext('2d'), w = size.w, h = size.h, r = size.r;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.arcTo(w, 0, w, r, r);
  ctx.lineTo(w, h - r); ctx.arcTo(w, h, w - r, h, r);
  ctx.lineTo(r, h); ctx.arcTo(0, h, 0, h - r, r);
  ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.clip();
  // Cover-crop. A prepared bitmap is already the card's width, so for a 16:9
  // stream this is a straight copy; anything else is scaled here as a fallback.
  var src = entry.bitmap || entry.img;
  var iw = entry.bitmap ? src.width : src.naturalWidth, ih = entry.bitmap ? src.height : src.naturalHeight;
  if (iw && ih) {
    var s = Math.max(w / iw, h / ih);
    ctx.drawImage(src, (iw - w / s) / 2, (ih - h / s) / 2, w / s, h / s, 0, 0, w, h);
  }
  ctx.restore();
}
// One controller per card element; each follows its own list's focus. Repeat
// updates for the same row are no-ops (re-renders must not flash the card).
// Where an element sits once any entrance animation has finished. The sidebar
// slides and the surf panel scales in, and a warmed preview now appears within
// that animation, so a getBoundingClientRect would pin it to the moving start
// frame. Offsets ignore transforms; scrolled ancestors are subtracted by hand.
function layoutRect(el) {
  var x = 0, y = 0, w = el.offsetWidth, h = el.offsetHeight, n = el;
  while (n) {
    x += n.offsetLeft; y += n.offsetTop;
    var p = n.offsetParent;
    for (var a = n.parentNode; a && a !== p && a.nodeType === 1; a = a.parentNode) { x -= a.scrollLeft; y -= a.scrollTop; }
    if (p) { x += p.clientLeft - p.scrollLeft; y += p.clientTop - p.scrollTop; }
    n = p;
  }
  return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}
// The card sits at 0,0 and moves by transform, so the CSS transition can glide it
// from row to row on the compositor.
function positionStreamPreview(panel, row, container) {
  if (!row || !container) return;
  var anchor = layoutRect(row), edge = layoutRect(container);
  var clip = layoutRect(row.parentNode);
  var vis = anchor.bottom <= clip.top || anchor.top >= clip.bottom ? 'hidden' : '';
  if (panel.style.visibility !== vis) panel.style.visibility = vis;
  var width = panel.offsetWidth, height = panel.offsetHeight;
  var viewWidth = window.innerWidth || 1920, viewHeight = window.innerHeight || 1080;
  var left = edge.right + 24;
  if (left + width > viewWidth - 24) left = edge.left - width - 24;
  var x = Math.round(Math.max(24, Math.min(viewWidth - width - 24, left)));
  var y = Math.round(Math.max(24, Math.min(viewHeight - height - 24, anchor.top + (anchor.height - height) / 2)));
  var transform = 'translate(' + x + 'px,' + y + 'px)';
  if (panel.style.transform !== transform) panel.style.transform = transform;
}
function makePreviewCard(elId, currentSlugFn, positionFn) {
  var slugShowing = null, urlShowing = null, timer = null, titleFont = null;
  function el() { return document.getElementById(elId); }
  function hide() {
    slugShowing = null; urlShowing = null;
    var e = el();
    if (e && e.className !== 'hidden') e.className = 'hidden';
  }
  // Show the card in a state and move it to the highlighted row. Coming out of
  // hiding it jumps straight there; while it is up it glides.
  function reveal(e, cls) {
    var wasHidden = e.className === 'hidden';
    if (e.className !== cls) e.className = cls;
    if (!wasHidden) { positionFn(e); return; }
    e.style.transition = 'none';
    positionFn(e);
    void e.offsetWidth;                 // commit the jump before transitions return
    e.style.transition = '';
  }
  function setTitle(e, slug) {
    var tEl = e.querySelector('.prevtitle');
    if (!tEl) return;
    var c = state.channels[slug];
    var title = (c && c.title) || '';
    tEl.style.display = title ? '' : 'none';
    if (!title) { tEl.textContent = ''; return; }
    // Same hand-rolled ".." as the channel list, so the two never disagree. The
    // card has a fixed size, so its font and text width are read once. It has to be
    // visible for clientWidth to read, hence the fallback.
    if (!titleFont || titleFont.w <= 0) {
      var cs = getComputedStyle(tEl);
      titleFont = { font: cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily,
        w: tEl.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) };
    }
    var clipped = titleFont.w > 0 ? clipWithDots(title, titleFont.font, titleFont.w) : title;
    if (tEl.textContent !== clipped) tEl.textContent = clipped;
  }
  function present(slug) {
    if (slugShowing !== slug || currentSlugFn() !== slug) return;   // focus moved meanwhile
    var entry = previewCache[slug];
    if (!entry || !entry.ready) return;
    var e = el();
    if (urlShowing !== entry.url || e._frameSlug !== slug) {
      drawPreviewFrame(e, entry);
      urlShowing = entry.url; e._frameSlug = slug;
    }
    reveal(e, '');
    setTitle(e, slug);
  }
  // A warmed frame is ready to draw: show it on the spot, and swap in a newer one
  // if the warmer brings it while the card is still up.
  function showWarm(slug) {
    present(slug);
    if (Date.now() - previewCache[slug].t >= PREVIEW_REFRESH_MS) {
      fetchPreviewUrl(slug, function () { if (slugShowing === slug) present(slug); });
    }
  }
  function update() {
    var slug = currentSlugFn();
    var c = slug ? state.channels[slug] : null;
    var want = !!(slug && c && c.live && slug !== state.current);
    if (want && slug === slugShowing) { if (el().className !== 'hidden') positionFn(el()); return; }
    clearTimeout(timer);
    if (!want) { hide(); return; }
    slugShowing = slug;
    if (previewReady(slug)) { showWarm(slug); return; }
    // Not warmed yet. A card already up glides along with a spinner; a hidden one
    // waits for the highlight to settle. Either way the network is only asked once
    // the highlight rests.
    var e = el();
    urlShowing = null;
    if (e.className !== 'hidden') { reveal(e, 'loading'); setTitle(e, slug); }
    timer = setTimeout(function () {
      if (currentSlugFn() !== slug) { hide(); return; }
      reveal(e, 'loading');
      setTitle(e, slug);
      fetchPreviewUrl(slug, function () {
        if (slugShowing !== slug) return;
        if (previewReady(slug)) present(slug);
        else hide();                    // no thumbnail: no stuck spinner
      }, true);
    }, 150);
  }
  return { update: update, cancel: function () { clearTimeout(timer); hide(); } };
}
var sidePreviewCard = makePreviewCard('sidepreview',
  function () {
    if (!state.sidebarOpen || settings.open || qualityopt.open || chatopt.open) return null;
    var item = state.sideItems[state.sideFocus];
    return (item && (item.type === 'chan' || item.type === 'temp')) ? item.slug : null;
  },
  function (e) {
    var list = document.getElementById('fav-list');
    var row = list.children[state.sideFocus];
    positionStreamPreview(e, row, document.getElementById('sidebar'));
  });
/* Over a VOD the preview window lands on top of the transport controls, which ride with
   the sidebar. So in a VOD the preview is not armed by merely opening the list — it waits
   until the highlight actually moves or the pointer lands on a row. Live playback is
   unaffected: there are no controls underneath to cover. */
var sidePreviewArmed = true;
function armSidePreview() { sidePreviewArmed = true; }
function scheduleSidePreview() {
  if (!sidePreviewArmed) { sidePreviewCard.cancel(); return; }
  sidePreviewCard.update();
}
var sideRows = Object.create(null);
var sidePrepareTimer = null;
function prepareSidebarSoon() {
  if (sidePrepareTimer || !state.ready || document.hidden || state.sidebarOpen) return;
  // Let startup/playback and the refresh callbacks finish before preparing UI.
  sidePrepareTimer = setTimeout(function () {
    sidePrepareTimer = null;
    if (!document.hidden && !state.sidebarOpen) renderSidebar();
  }, 500);
}
// The second line: an optional category span and the rest in title colour.
function setSideSub(el, cat, rest) {
  var full = cat + '\n' + rest;
  if (el.getAttribute('data-full') === full) return false;
  el.setAttribute('data-full', full);
  if (el.children.length !== 2) el.innerHTML = '<span class="favcat"></span><span class="favtitle"></span>';
  el.children[0].textContent = cat;
  el.children[1].textContent = rest;
  el._sideParts = { cat: cat, rest: rest };
  el._sideClipKey = null;
  return true;
}
function setSideText(el, full) {
  full = String(full == null ? '' : full);
  if (el.getAttribute('data-full') === full) return false;
  el.setAttribute('data-full', full);
  el.textContent = full;
  el._sideClipKey = null;
  return true;
}
window.addEventListener('resize', function () {
  sideTextStyle = null;
  sideLayout = null;
  if (state.ready) renderSidebar();
});
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
  var countText = state.netDown ? 'Connection lost' :
    (state.order.length ? (liveCount() + ' / ' + state.order.length + ' live') : '');
  var countClass = state.netDown ? 'neterr' : '';
  if (cc.textContent !== countText) cc.textContent = countText;
  if (cc.className !== countClass) cc.className = countClass;

  var list = document.getElementById('fav-list');
  var nextRows = Object.create(null), structureChanged = !sideLayout, textChanged = false;
  state.sideItems.forEach(function (item, index) {
    var key = item.type + ':' + (item.slug || '');
    var row = sideRows[key];
    if (item.type === 'offline-group') {
      if (!row) {
        row = document.createElement('div');
        row.setAttribute('data-base', 'favrow offlinegroup');
        row.setAttribute('data-type', 'offline-group');
        row.className = 'favrow offlinegroup';
        row.innerHTML = '<span class="offline-chevron"></span><span class="offline-label">Offline channels</span><span class="offline-count"></span>';
      }
      if (row._sideExpanded !== state.offlineExpanded) {
        row.children[0].innerHTML = state.offlineExpanded
          ? '<svg viewBox="0 0 24 24"><path d="M4 8l8 8 8-8"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M8 4l8 8-8 8"/></svg>';
        row._sideExpanded = state.offlineExpanded;
      }
      if (row.children[2].textContent !== String(item.count)) row.children[2].textContent = String(item.count);
    } else if (item.type === 'add') {
      if (!row) {
        row = document.createElement('div');
        row.setAttribute('data-base', 'favrow addrow');
        row.setAttribute('data-type', 'add');
        row.className = 'favrow addrow';
        row.innerHTML = '<span class="addplus">+</span><span class="addtext">Add channel</span>';
      }
    } else {
      var isTemp = item.type === 'temp';
      var slug = item.slug, c = state.channels[slug], pinned = !isTemp && isPinned(slug);
      // A blocked row keeps all its live information and is merely dimmed.
      var blocked = isChannelBlocked(c);
      var base = 'favrow' + (isTemp ? ' temp' : '') + (c.live ? '' : ' offline') +
                 (blocked ? ' blocked' : '') +
                 (slug === state.current ? ' current' : '') + (pinned ? ' pinned' : '');
      if (!row) {
        row = document.createElement('div');
        row.setAttribute('data-slug', slug);
        row.innerHTML = '<div class="favav"></div><div class="favmid"><div class="favname"></div><div class="favgame"></div></div><div class="favinfo"></div><div class="favactions"></div>';
      }
      if (row.getAttribute('data-base') !== base) {
        if (row.hasAttribute('data-base')) textChanged = true;   // live/pinned changes the text width
        row.setAttribute('data-base', base);
        row.className = base + (row === sideFocusEl && state.playerToolFocus < 0 ? ' focused' : '');
      }

      var av = row.children[0], avClass = 'favav' + (c.live ? '' : ' off');
      if (av.className !== avClass) av.className = avClass;
      var avatar = c.avatar || '';
      if (row._sideAvatar !== avatar) {
        av.style.backgroundImage = avatar ? 'url(' + avatar + ')' : '';
        row._sideAvatar = avatar;
      }
      var initial = avatar ? '' : (c.name || slug).charAt(0).toUpperCase();
      if (av.textContent !== initial) av.textContent = initial;

      var mid = row.children[1];
      if (setSideText(mid.children[0], c.name)) textChanged = true;
      if (c.live) {
        if (setSideSub(mid.children[1], c.category || 'Live', c.title ? ' · ' + c.title : '')) textChanged = true;
      } else if (setSideSub(mid.children[1], '', offlineLabel(slug))) textChanged = true;

      var info = row.children[2];
      var infoHtml = '';
      if (pinned) infoHtml += '<span class="pinmark">' + pinIcon() + '</span>';
      if (c.live) infoHtml += '<span class="livedot"></span><span class="favview">' + fmtViewers(c.viewers) + '</span>';
      if (row._sideInfo !== infoHtml) { info.innerHTML = infoHtml; row._sideInfo = infoHtml; }

      var act = row.children[3], actHtml;
      if (isTemp) {
        actHtml = '<span class="actbtn addbtn" data-act="addfav" title="Add to your channels">+</span>';
      } else {
        actHtml =
          '<span class="actbtn pinbtn' + (pinned ? ' on' : '') + '" data-act="pin">' + pinIcon() + '</span>' +
          '<span class="actbtn rmbtn" data-act="remove">✕</span>';
      }
      if (row._sideActions !== actHtml) { act.innerHTML = actHtml; row._sideActions = actHtml; }
    }

    nextRows[key] = row;
    if (list.children[index] !== row) {
      list.insertBefore(row, list.children[index] || null);
      structureChanged = true;
    }
  });
  while (list.children.length > state.sideItems.length) {
    list.removeChild(list.lastChild);
    structureChanged = true;
  }
  sideRows = nextRows;

  if (textChanged || !sideTextStyle) clipSidebarText();
  if (structureChanged) measureSideLayout(list);

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
  var addClass = sideLayout && sideLayout.maxScroll > 2 ? '' : 'hidden';
  if (addBtn && addBtn.className !== addClass) addBtn.className = addClass;
  // Nothing to refresh when there are no channels, so hide that button.
  var refBtn = document.getElementById('side-refresh');
  if (refBtn && refBtn.classList.contains('hidden') !== !state.order.length)
    refBtn.classList.toggle('hidden', !state.order.length);
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
    // Still playing: it stays in the list as a temporary row, with its add button.
    if (a.slug === state.current && !state.vod) state.tempChannel = a.slug;
    toast('Removed ' + name);
    // Sorting is local; no need to re-fetch every channel to drop one row.
    sortOrder(currentFavoritesWithData());
    if (state.sidebarOpen) renderSidebar();
    if (!state.current) showNothing();
    saveChannelCache();
  }
  resetIdle();
}
function confirmNo() {
  pendingAction = null;
  setMode('player');
  if (state.sidebarOpen) renderSidebar();
  if (!state.current) showNothing();
  resetIdle();
}
function togglePinFocused() {
  var item = state.sideItems[state.sideFocus];
  if (!item || item.type !== 'chan') return;
  var nowPinned = togglePin(item.slug);
  toast((nowPinned ? 'Pinned ' : 'Unpinned ') + state.channels[item.slug].name);
  sortOrder(currentFavoritesWithData());          // a pin only reorders; no network needed
  if (state.sidebarOpen) renderSidebar(item.slug);
  saveChannelCache();
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
    if (state.sidebarOpen) renderSidebar();   // closed meanwhile: leave it closed
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
  resetIdle();                         // the idle timer ran out while the dialog was up
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
  var favsInResults = getFavorites();   // once per render, not once per row
  add.results.forEach(function (c, i) {
    var name = (c.user && c.user.username) || c.slug;
    var already = favsInResults.indexOf(c.slug) !== -1;
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
var addFocusEl = null;
// data-base carries the 'already following' state
function addRowBaseOf(row) { return row.getAttribute('data-base') || 'aresult'; }
function applyAddFocus() {
  var box = document.getElementById('addresults');
  // add.focus is -1 while the text box has focus, which clears the list highlight
  var row = add.focus >= 0 ? (box.children[add.focus] || null) : null;
  addFocusEl = swapFocus(box, addFocusEl, row, addRowBaseOf, true);
  scrollIntoViewport(box, row, 6);
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
  if (isFavorite(slug)) {                          // already following — don't add it again
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
var BROWSE_MEMORY_MS = 60000;     // reopen inside this window and the loaded pool is reused
var browse = { open: false, langs: [], langIdx: 0, zone: 'grid', gridIdx: 0,
               raw: [], streams: [], page: 1, hasMore: true, fetching: false,
               cats: [], session: 0, closedAt: 0, scrollTop: 0, langMenuOpen: false,
               sort: 'viewers', discover: false, hideBlocked: true, renderLimit: 60,
               fillTimer: null, retryTimer: null, retryCount: 0, error: false, capped: false, headerIdx: 3, pinIdx: 0 };
var CATALOGUE_LIMIT = 2000;
var browseGridView = null, catsGridView = null, vodGridView = null;
var BROWSE_HEADERS = ['browse-cats-btn', 'browse-discover', 'browse-hideblocked', 'browse-langbtn', 'browse-close'];
function catalogueImage(el, url, label) {
  if (window.UIImages) UIImages.watch(el, url || '', label || 'Artwork unavailable');
  else if (url) el.style.backgroundImage = 'url(' + url + ')';
}
function catalogueKey(s) { return (s.channel && s.channel.slug) || s.slug || ''; }
function catalogueIdentityIndex(list, key, identity, fallback) {
  if (identity != null) for (var i = 0; i < list.length; i++) if (key(list[i], i) === identity) return i;
  return Math.max(0, Math.min(list.length - 1, fallback || 0));
}
function catalogueMove(index, n, cols, dx, dy) {
  if (!n) return 0;
  if (dx) return Math.max(0, Math.min(n - 1, index + dx));
  if (dy > 0) return Math.min(n - 1, index + cols);
  return Math.max(0, index - cols);
}
function catalogueUpdate(node, fresh) {
  if (window.UIImages) UIImages.release(node);
  node.className = fresh.className;
  node.setAttribute('data-base', fresh.getAttribute('data-base') || fresh.className);
  if (fresh.hasAttribute('role')) node.setAttribute('role', fresh.getAttribute('role')); else node.removeAttribute('role');
  while (node.firstChild) node.removeChild(node.firstChild);
  while (fresh.firstChild) node.appendChild(fresh.firstChild);
}
function catalogueTerminal(kind, msg, retry) {
  return { catalogueTerminal: true, kind: kind, message: msg, retry: !!retry };
}
function makeCatalogueTerminal(item) {
  var node = document.createElement('div');
  node.className = item.kind === 'cats' ? 'ccard catalogue-state' : 'bcard catalogue-state';
  node.setAttribute('data-base', node.className);
  node.setAttribute('role', item.retry ? 'button' : 'status');
  node.textContent = item.message + (item.retry ? ' · Retry' : '');
  node.style.display = 'flex'; node.style.alignItems = 'center'; node.style.justifyContent = 'center';
  node.style.padding = '24px'; node.style.fontSize = '25px'; node.style.textAlign = 'center';
  return node;
}
function catalogueSkeletons(view, kind) {
  var list = [];
  for (var i = 0; i < 8; i++) list.push({ skeleton: i });
  view.setItems(list, function (item) { return 'skeleton-' + item.skeleton; }, function () {
    var node = document.createElement('div');
    node.className = kind === 'cats' ? 'ccard cskel' : 'bcard bskel';
    node.innerHTML = kind === 'cats' ? '<div class="cbanner"></div>' : '<div class="bthumb"></div><div class="bmeta"><div class="skline w1"></div><div class="skline w2"></div></div>';
    node.setAttribute('data-base', node.className);
    node.style.animation = 'none';
    return node;
  });
}
function catalogueAnchoredScroll(view, nextIndex, key, saved) {
  var old = view.focused, m = view.metrics;
  if (m && old >= 0 && view.keys[old] === '$' + key && view.get(old)) {
    return Math.max(0, saved + (Math.floor(nextIndex / m.cols) - Math.floor(old / m.cols)) * m.pitchY);
  }
  return saved;
}
function catalogueMountedFocus(view, index, active, baseOf) {
  var next = view.get(index), focused = view.content.querySelectorAll('.focused');
  for (var i = 0; i < focused.length; i++) if (focused[i] !== next || !active) focused[i].className = baseOf(focused[i]);
  if (next && active) next.className = baseOf(next) + ' focused';
  return next;
}
function getBrowseGrid() {
  if (!browseGridView) browseGridView = new VirtualGrid(document.getElementById('browse-grid'), { columns: BROWSE_COLS, height: 350, onRender: function () {
    browseFocusEl = catalogueMountedFocus(browseGridView, browse.gridIdx, browse.zone === 'grid', browseCardBaseOf);
  } });
  return browseGridView;
}
var BROWSE_SORTS = [
  { key: 'viewers', label: 'Top' },
  { key: 'newest',  label: 'New' },
  { key: 'small',   label: 'Small' }
];
// The sort chip is gone from the header; Browse always orders by viewers. The
// sort machinery is left in place so the control can come back cheaply.
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
  renderBrowseSort();
  renderBrowse();
  toast('Sort: ' + (next.key === 'viewers' ? 'Most viewers' : (next.key === 'newest' ? 'Recently started' : 'Small streams first')));
}
/* "Hide Followed": hide channels you already follow — browsing is for finding
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
  refilterBrowse();
  toast(browse.discover ? 'Hiding channels you follow' : 'Showing all channels');
}
/* "Hide Blocked": drop streams whose category you have blocked out of the grid.
   Blocking already sinks and greys a followed channel in your list, so seeing
   the same categories while browsing is noise — this one defaults ON. Picking a
   category on purpose still shows it (see renderBrowse). */
function loadBrowseHideBlockedPref() {
  try { return localStorage.getItem('kicktv.browsehideblocked') !== '0'; } catch (e) { return true; }
}
function renderBrowseHideBlocked() {
  var el = document.getElementById('browse-hideblocked');
  if (el) el.className = browse.hideBlocked ? 'on' : '';
}
function toggleBrowseHideBlocked() {
  browse.hideBlocked = !browse.hideBlocked;
  try { localStorage.setItem('kicktv.browsehideblocked', browse.hideBlocked ? '1' : '0'); } catch (e) {}
  renderBrowseHideBlocked();
  refilterBrowse();
  toast(browse.hideBlocked ? 'Hiding blocked categories' : 'Showing blocked categories');
}
// Static placeholders keep the first page geometry stable while loading.
function renderBrowseSkeletons() { catalogueSkeletons(getBrowseGrid(), 'browse'); }

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
// Kick ships a srcset with every thumbnail and banner, and the plain `src` is the
// 1280-wide one. A grid card is 376px across, so that default carries about eleven
// times the pixels it can ever show — sixty of them at a time, decoded on the main
// thread, is most of what opening a grid costs. Take the narrowest variant that
// still covers the card. (The preview window has always done this by hand; see
// pickPreviewUrl.)
var CARD_IMG_W = 400;   // .bcard and .ccard are 408px wide with a 4px border
function pickSrcsetUrl(srcset, minWidth) {
  var parts = String(srcset || '').split(',');
  var best = null, bestW = 0, widest = null, widestW = -1;
  for (var i = 0; i < parts.length; i++) {
    var m = /(\S+)\s+(\d+)w$/.exec(parts[i].trim());
    if (!m) continue;
    var w = parseInt(m[2], 10);
    if (w > widestW) { widestW = w; widest = m[1]; }
    if (w >= minWidth && (best === null || w < bestW)) { bestW = w; best = m[1]; }
  }
  return best || widest;   // nothing wide enough: take the biggest on offer
}
function thumbUrl(s) {
  var t = s && s.thumbnail;
  if (!t) return null;
  if (typeof t === 'string') return t;
  return pickSrcsetUrl(t.srcset, CARD_IMG_W) || t.src || t.url || null;
}
function openBrowse(categorySlug, categoryName) {
  if (!state.ready) return;
  cancelBrowseFill();
  browse.open = true;
  showCursor();
  closeSidebar();
  pausePlaybackForBrowse();
  document.getElementById('browse').className = '';
  loadBrowseLangPref();
  browse.langMenuOpen = false;      // never reopen straight into the dropdown
  renderBrowseLangBtn();
  renderBrowseLangMenu();
  // Reopened within the memory window: the directory pool we already hold is good
  // enough, so skip the skeletons and the refetch and put the grid back as it was.
  // Counts and live/offline state can be up to BROWSE_MEMORY_MS stale — that is the
  // trade. An explicit category runs its own deeper page chain, so it always loads
  // fresh rather than being refiltered out of this pool.
  if (!categorySlug && browse.raw.length && (Date.now() - browse.closedAt) < BROWSE_MEMORY_MS) {
    browse.session++;            // orphan anything still in flight from the last opening
    browse.fetching = false;     // ...and clear the flag it guards, or Browse never loads again
    browse.zone = 'grid';
    renderBrowseSort();
    renderBrowseDiscover();
    renderBrowseHideBlocked();
    updateBrowseTitle();
    renderPinnedCatChips();
    renderBrowse();              // ends in applyBrowseFocus, which scrolls the focused card in
    var g = document.getElementById('browse-grid');
    if (g) g.scrollTop = browse.scrollTop;   // ...so restore the exact position after it
    return;
  }
  browse.zone = 'grid'; browse.gridIdx = 0;
  // optionally open pre-filtered (the clickable category in the top bar)
  browse.cats = categorySlug ? [{ slug: categorySlug, name: categoryName || categorySlug }] : [];
  browse.session++;               // orphan any request still in flight from a previous opening
  browse.raw = [];
  browse.streams = []; browse.page = 1; browse.hasMore = true; browse.fetching = false;
  browse.renderLimit = 60; browse.error = false; browse.capped = false;
  getBrowseGrid().clear();
  browse.sort = 'viewers';
  browse.discover = loadBrowseDiscoverPref();
  browse.hideBlocked = loadBrowseHideBlockedPref();
  renderBrowseSort();
  renderBrowseDiscover();
  renderBrowseHideBlocked();
  renderPinnedCatChips();
  renderBrowseSkeletons();
  updateBrowseTitle();
  loadBrowseMore();
}
// The title stays "Live now" — the highlighted Categories button and the
// selected chip already show which filter is active.
function updateBrowseTitle() {
  var btn = document.getElementById('browse-cats-btn');
  if (btn) btn.className = browse.cats.length ? 'on' : '';
}
function closeBrowse() {
  browse.open = false;
  cancelBrowseFill();
  browse.session++;
  browse.fetching = false;
  closeBrowseLangMenu();
  // Remember where we were. The pool stays in memory; openBrowse decides whether
  // it is still fresh enough to reuse.
  var grid = document.getElementById('browse-grid');
  browse.scrollTop = grid ? grid.scrollTop : 0;
  browse.closedAt = Date.now();
  document.getElementById('browse').className = 'hidden';
  clearTimeout(browsePeekTimer);
  if (typeof flushChatRender === 'function') flushChatRender();
  resumePlaybackAfterBrowse();
}
function cancelBrowseFill() {
  clearTimeout(browse.fillTimer);
  clearTimeout(browse.retryTimer);
  browse.fillTimer = null;
  browse.retryTimer = null;
  browse.retryCount = 0;
}
// Count complete rows of real cards, excluding a partial row and the loader.
// The first card of the last two full rows must be entirely below the viewport.
function browseNeedsMoreRows() {
  var view = getBrowseGrid();
  var m = view.metrics;
  if (!m) return true;
  return Math.ceil(browse.streams.length / BROWSE_COLS) * m.pitchY < view.container.scrollTop + m.height + 2 * m.pitchY;
}
function scheduleBrowseFill() {
  if (!browse.open || cats.open || browse.fillTimer !== null || browse.error || !browse.hasMore) return;
  var ses = browse.session;
  browse.fillTimer = setTimeout(function () {
    browse.fillTimer = null;
    if (browse.open && !cats.open && ses === browse.session && browseNeedsMoreRows()) loadBrowseMore();
  }, 0);
}
// The loading card counts as one focusable (but inert) cell at the end, so
// Down can reach it and the grid scrolls to reveal it.
function browseFocusCount() { return browse.streams.length + (browse.error || browse.fetching || !browse.hasMore ? 1 : 0); }
function renderBrowseStatus() {
  setBrowseStatus('');
}
// One serialized request at a time, until two spare rows or the directory's end.
function loadBrowseMore() {
  if (!browse.open || cats.open || browse.fetching || !browse.hasMore) return;
  browse.fetching = true; browse.error = false;
  if (browse.raw.length) renderBrowse(true); else setBrowseStatus('Loading live streams...');
  var pg = browse.page, ses = browse.session;
  serviceGet('/stream/livestreams/en?page=' + pg + '&limit=50&sort=desc', function (err, data) {
    if (ses !== browse.session || !browse.open) return;
    browse.fetching = false;
    if (err || !data || !Array.isArray(data.data)) {
      browse.error = true; renderBrowse(true); return;
    }
    // Slugs already in the pool, kept alongside it instead of rebuilt per page.
    if (browse.rawSeenFor !== browse.raw || browse.rawSeenCount !== browse.raw.length) {
      browse.rawSeen = Object.create(null);
      for (var j = 0; j < browse.raw.length; j++) browse.rawSeen['$' + catalogueKey(browse.raw[j])] = true;
    }
    var arr = data.data, seen = browse.rawSeen, added = 0;
    for (var i = 0; i < arr.length && browse.raw.length < CATALOGUE_LIMIT; i++) {
      var it = arr[i], ch = it.channel || {}, cat = (it.categories && it.categories[0]) || null;
      var slug = ch.slug || it.slug || '';
      if (!slug || seen['$' + slug]) continue;
      seen['$' + slug] = true; added++;
      var entry = { viewer_count: it.viewer_count || 0, language: it.language || '',
        session_title: it.session_title || '', created_at: it.created_at || '', thumbnail: it.thumbnail || null,
        categories: cat ? [{ name: cat.name || '', slug: cat.slug || '' }] : [],
        channel: { slug: slug, user: { username: (ch.user && ch.user.username) || '' } } };
      entry.__bot = looksBotStream(entry);          // decided once here, not on every render
      browse.raw.push(entry);
    }
    browse.rawSeenFor = browse.raw; browse.rawSeenCount = browse.raw.length;
    browse.page = pg + 1;
    browse.capped = browse.raw.length >= CATALOGUE_LIMIT;
    browse.hasMore = !!arr.length && !!added && !browse.capped;
    renderBrowse(true);
    scheduleBrowseFill();
  }, { priority: 1 });
}
/* Languages live behind one button in the top-right corner rather than eight
   chips across the header: the row was 1152px wide and left nothing for anything
   else. The button carries the count, the dropdown carries the checkboxes. */
function renderBrowseLangBtn() {
  var el = document.getElementById('browse-langbtn');
  if (!el) return;
  var n = browse.langs.length;
  var labels = [];
  for (var i = 0; i < n; i++) {
    var label = browse.langs[i];
    for (var j = 1; j < BROWSE_LANGS.length; j++) {
      if (BROWSE_LANGS[j].value === browse.langs[i]) { label = BROWSE_LANGS[j].label; break; }
    }
    labels.push(label);
  }
  el.textContent = n ? labels[0] + (n > 1 ? ' +' + (n - 1) : '') : 'All languages';
  el.title = n ? 'Languages: ' + labels.join(', ') : 'Filter by language';
  el.className = (n ? 'on' : '') +
                 (browse.zone === 'lang' && !browse.langMenuOpen ? ' focused' : '');
}
function renderBrowseLangMenu() {
  var box = document.getElementById('browse-langmenu');
  if (!box) return;
  box.className = browse.langMenuOpen ? '' : 'hidden';
  if (!browse.langMenuOpen) return;
  for (var i = 0; i < BROWSE_LANGS.length; i++) {
    var l = BROWSE_LANGS[i], on = i === 0 ? !browse.langs.length : browse.langs.indexOf(l.value) !== -1;
    var row = box.children[i];
    if (!row) {
      row = document.createElement('div'); row.setAttribute('data-idx', i);
      var cb = document.createElement('span'); cb.className = 'blangbox'; row.appendChild(cb);
      row.appendChild(document.createTextNode(i === 0 ? 'All languages' : l.label)); box.appendChild(row);
    }
    var cls = 'blangrow' + (on ? ' on' : '') + (i === browse.langIdx ? ' focused' : '');
    if (row.className !== cls) row.className = cls;
    var tick = on ? '✓' : ''; if (row.firstChild.textContent !== tick) row.firstChild.textContent = tick;
  }
}
function openBrowseLangMenu() {
  browse.langMenuOpen = true;
  browse.zone = 'lang'; browse.headerIdx = 3;
  if (!(browse.langIdx >= 0 && browse.langIdx < BROWSE_LANGS.length)) browse.langIdx = 0;
  renderBrowseLangMenu();
  renderBrowseLangBtn();
}
function closeBrowseLangMenu() {
  if (!browse.langMenuOpen) return;
  browse.langMenuOpen = false;
  renderBrowseLangMenu();
  renderBrowseLangBtn();
}
function toggleBrowseLangMenu() {
  if (browse.langMenuOpen) closeBrowseLangMenu(); else openBrowseLangMenu();
}
/* View-botted fake streams. They come in waves under one category with random
   channel names and random titles, and inflated viewer counts that put them
   above real streamers. Measured against 960 live streams: matching on the title
   alone gives one false positive (a bare URL) and on the name alone ninety-seven
   (Cristorata7, Ac7ionMan and friends), so both must look generated at once.
   A real title nearly always contains a space; a real name rarely mixes digits
   through letters. Requiring mixed case in the title as well took the measured
   false positives to zero while still catching every bot in the sample. */
function botNameish(s) {
  s = String(s || '').trim();
  if (!s || s.indexOf(' ') !== -1 || s.length < 8) return false;
  return /[0-9]/.test(s) && /[a-z]/i.test(s);
}
function botTitleish(s) {
  s = String(s || '').trim();
  if (!s || s.indexOf(' ') !== -1 || s.length < 10) return false;
  if (/^https?:/i.test(s)) return false;          // a bare link is not keyboard mash
  return /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}
function looksBotStream(s) {
  if (!s) return false;
  var ch = s.channel || {};
  var name = (ch.user && ch.user.username) || ch.slug || '';
  return botTitleish(s.session_title) && botNameish(name);
}
function isBotStream(s) {
  if (!s) return false;
  if (s.__bot === undefined) s.__bot = looksBotStream(s);
  return s.__bot;
}
function makeBrowseCard(s, i, favs) {
  var ch = s.channel || {}, user = ch.user || {};
  var card = document.createElement('div');
  card.className = 'bcard';
  card.setAttribute('data-idx', i);
  var url = thumbUrl(s);
  var thumb = document.createElement('div');
  thumb.className = 'bthumb';
  catalogueImage(thumb, url, user.username || ch.slug || 'Live stream');
  var v = document.createElement('span');
  v.className = 'bviewers';
  v.innerHTML = '<span class="bdot"></span>';
  v.appendChild(document.createTextNode(fmtViewers(s.viewer_count || 0)));
  thumb.appendChild(v);
  var already = isFavorite(ch.slug);
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
  return card;
}
/* Selected categories. An array rather than a single slug so Browse can hold
   several at once; pick order is preserved so the status line reads the way you
   built it. hasBrowseCat is asked once per stream per render, but the list is a
   handful of entries, so a linear scan beats maintaining a map. */
function hasBrowseCat(slug) {
  if (!slug) return false;
  for (var i = 0; i < browse.cats.length; i++) if (browse.cats[i].slug === slug) return true;
  return false;
}
function browseCatLabel() {
  var out = [];
  for (var i = 0; i < browse.cats.length; i++) out.push(browse.cats[i].name || browse.cats[i].slug);
  return out.join(' / ');
}
// Everything that has to catch up once the selection changes. The Categories
// popup stays open while you pick, so its ticks re-render too.
function afterBrowseCatChange() {
  updateBrowseTitle();
  refilterBrowse();              // also re-counts the chips
  if (cats.open) renderCats();
}
function toggleBrowseCat(slug, name) {
  if (!slug) return;
  var out = [], found = false;
  for (var i = 0; i < browse.cats.length; i++) {
    if (browse.cats[i].slug === slug) found = true;
    else out.push(browse.cats[i]);
  }
  if (!found) out.push({ slug: slug, name: name || slug });
  browse.cats = out;
  afterBrowseCatChange();
}
function clearBrowseCats() {
  if (!browse.cats.length) return;
  browse.cats = [];
  afterBrowseCatChange();
}
// A filter changed: if the focused stream is filtered away, start over at the
// top instead of keeping a numeric index into an unrelated list.
function refilterBrowse() { renderBrowse(false, true); }
// Filtering and sorting up to 2000 streams is the expensive part of a render, and
// most renders (the loading card appearing, a focus refresh) change neither the
// pool nor the filters. The result is kept until one of them does.
function browseFilterKey() {
  return [(browse.raw || []).length, settings.hideBots ? 1 : 0, browse.langs.join(','),
          browse.discover ? getFavorites().join(',') : '', JSON.stringify(browse.cats),
          browse.hideBlocked ? JSON.stringify(getBlockedCats()) : '', browse.sort].join('|');
}
var browseFilterMemo = { key: null, raw: null, list: null };
function renderBrowse(preserveScroll, filterChanged) {
  var onStatus = browse.gridIdx >= browse.streams.length;   // the loading/retry/end card
  var old = onStatus ? null : browse.streams[browse.gridIdx];
  var identity = old ? catalogueKey(old) : null;
  var fkey = browseFilterKey();
  if (browseFilterMemo.key === fkey && browseFilterMemo.raw === browse.raw && browseFilterMemo.list) {
    finishRenderBrowse(browseFilterMemo.list.slice(), preserveScroll, filterChanged, onStatus, identity);
    return;
  }
  var list = (browse.raw || []).slice();
  if (settings.hideBots) list = list.filter(function (s) { return !isBotStream(s); });
  if (browse.langs.length) list = list.filter(function (s) { return browse.langs.indexOf(s.language) !== -1; });
  if (browse.discover) {
    list = list.filter(function (s) { return !isFavorite((s.channel || {}).slug); });
  }
  // An explicit selection of any size beats Hide Blocked: asking for a category
  // by name — including a blocked one you pinned — has to show it, or the grid
  // comes back empty and the chip looks broken. getBlockedCats() is memoized, so
  // an empty block list makes the other branch a cheap walk.
  if (browse.cats.length) {
    list = list.filter(function (s) {
      var c0 = s.categories && s.categories[0];
      return !!(c0 && hasBrowseCat(c0.slug));
    });
  } else if (browse.hideBlocked) {
    list = list.filter(function (s) {
      var c0 = s.categories && s.categories[0];
      return !(c0 && isCatBlocked(c0.slug));
    });
  }
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
  browseFilterMemo = { key: fkey, raw: browse.raw, list: list.slice() };
  finishRenderBrowse(list, preserveScroll, filterChanged, onStatus, identity);
}
function finishRenderBrowse(list, preserveScroll, filterChanged, onStatus, identity) {
  var prevIdx = browse.gridIdx;
  browse.streams = list;
  var found = -1;
  if (identity !== null) for (var fi = 0; fi < list.length; fi++) if (catalogueKey(list[fi]) === identity) { found = fi; break; }
  var hasStatus = !!(browse.error || browse.fetching || !browse.hasMore);
  if (found !== -1) browse.gridIdx = found;
  else if (filterChanged) browse.gridIdx = 0;
  // Focus sat on the loading/retry card: keep it there (or on the first new card
  // that took its place) rather than snapping back onto the last stream.
  else if (onStatus) browse.gridIdx = Math.max(0, Math.min(prevIdx, list.length + (hasStatus ? 0 : -1)));
  else browse.gridIdx = Math.max(0, Math.min(list.length - 1, prevIdx || 0));
  var view = getBrowseGrid(), savedScroll = view.container.scrollTop;
  if (filterChanged && found === -1) { savedScroll = 0; view.container.scrollTop = 0; }
  if (preserveScroll && identity !== null) savedScroll = catalogueAnchoredScroll(view, browse.gridIdx, identity, savedScroll);
  var favs = getFavorites(), items = list.slice();
  if (browse.error) items.push(catalogueTerminal('browse', 'Could not load more streams', true));
  else if (browse.fetching) items.push(catalogueTerminal('browse', 'Loading more streams...'));
  else if (!browse.hasMore) items.push(catalogueTerminal('browse', browse.capped ? 'Directory limit reached · Refine your filters' : (list.length ? 'End of live directory' : 'No matching streams in this directory')));
  function create(item, i) { return item.catalogueTerminal ? makeCatalogueTerminal(item) : makeBrowseCard(item, i, favs); }
  function signature(item) { return JSON.stringify(item) + (item.catalogueTerminal ? '' : '|' + isFavorite(catalogueKey(item))); }
  view.setItems(items, function (item) { return item.catalogueTerminal ? '__state' : catalogueKey(item); }, function (item, i) {
    var node = create(item, i); node.__signature = signature(item); return node;
  }, function (node, item, i) {
    var sig = signature(item); if (node.__signature !== sig) { catalogueUpdate(node, create(item, i)); node.__signature = sig; }
  });
  renderBrowseStatus();
  renderPinnedCatChips();
  applyBrowseFocus(!!preserveScroll);
  if (preserveScroll) { view.container.scrollTop = savedScroll; view.refresh(); }
}

var browseFocusEl = null;
// the loading card is focusable but not activatable, so it keeps its own base class
function browseCardBaseOf(card) { return card.getAttribute('data-base') || 'bcard'; }
function applyBrowseFocus(preserveScroll) {
  renderBrowseLangBtn();
  for (var hi = 0; hi < BROWSE_HEADERS.length; hi++) {
    var h = document.getElementById(BROWSE_HEADERS[hi]);
    if (h) h.classList.toggle('focused', (browse.zone === 'header' || browse.zone === 'lang') && hi === browse.headerIdx && !browse.langMenuOpen);
  }
  var pins = document.getElementById('browse-pinnedcats'), chip = null;
  for (var pi = 0; pins && pi < pins.children.length; pi++) {
    pins.children[pi].classList.toggle('focused', browse.zone === 'pins' && pi === browse.pinIdx);
    if (pi === browse.pinIdx) chip = pins.children[pi];
  }
  if (browse.zone === 'pins' && chip) {
    if (chip.offsetLeft < pins.scrollLeft) pins.scrollLeft = chip.offsetLeft;
    else if (chip.offsetLeft + chip.offsetWidth > pins.scrollLeft + pins.clientWidth) pins.scrollLeft = chip.offsetLeft + chip.offsetWidth - pins.clientWidth;
  }
  var view = getBrowseGrid();
  view.focused = browse.gridIdx;
  var card = browse.zone === 'grid' && !preserveScroll ? view.focus(browse.gridIdx) : view.get(browse.gridIdx);
  browseFocusEl = swapFocus(view.content, browseFocusEl, card, browseCardBaseOf, browse.zone === 'grid');
  scheduleBrowsePeek(); scheduleBrowseFill();
}
// After dwelling on a browse card, refresh its thumbnail with the channel's
// current frame (the directory image can be minutes old).
var browsePeekTimer = null;
function scheduleBrowsePeek() {
  clearTimeout(browsePeekTimer);
  if (!browse.open || cats.open || browse.zone !== 'grid') return;
  var idx = browse.gridIdx, ses = browse.session;
  var s = browse.streams[idx];
  var slug = s && s.channel && s.channel.slug;
  if (!slug) return;
  browsePeekTimer = setTimeout(function () {
    if (!browse.open || cats.open || browse.session !== ses || browse.gridIdx !== idx || !browse.streams[idx] || catalogueKey(browse.streams[idx]) !== slug) return;
    function apply(url) {
      if (!browse.open || cats.open || browse.session !== ses || browse.gridIdx !== idx || !browse.streams[idx] || catalogueKey(browse.streams[idx]) !== slug) return;
      var card = getBrowseGrid().get(idx);
      var th = card && card.querySelector('.bthumb');
      if (th) catalogueImage(th, url, slug);
    }
    var cached = previewCache[slug];
    if (cached && Date.now() - cached.t < PREVIEW_REFRESH_MS) { apply(cached.url); return; }
    fetchPreviewUrl(slug, function () {
      var c2 = previewCache[slug];
      if (c2) apply(c2.url);
    }, true);
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
  renderBrowseLangBtn();
  renderBrowseLangMenu();    // the menu stays open so several can be picked at once
  refilterBrowse();          // just re-filter what we already fetched
}
function browseMove(dx, dy) {
  if (browse.langMenuOpen) {
    if (dy) { var ln = browse.langIdx + dy; if (ln >= 0 && ln < BROWSE_LANGS.length) { browse.langIdx = ln; renderBrowseLangMenu(); } }
    return;
  }
  var pins = document.getElementById('browse-pinnedcats');
  var hasPins = pins && pins.children.length && pins.className !== 'hidden';
  if (browse.zone === 'lang') { browse.zone = 'header'; browse.headerIdx = 3; }
  if (browse.zone === 'header') {
    if (dx) browse.headerIdx = Math.max(0, Math.min(BROWSE_HEADERS.length - 1, browse.headerIdx + dx));
    if (dy > 0) browse.zone = hasPins ? 'pins' : 'grid';
  } else if (browse.zone === 'pins') {
    if (dx) browse.pinIdx = Math.max(0, Math.min(pins.children.length - 1, browse.pinIdx + dx));
    if (dy < 0) browse.zone = 'header';
    if (dy > 0) browse.zone = 'grid';
  } else if (dy < 0 && browse.gridIdx < BROWSE_COLS) browse.zone = hasPins ? 'pins' : 'header';
  else browse.gridIdx = catalogueMove(browse.gridIdx, browseFocusCount(), BROWSE_COLS, dx, dy);
  applyBrowseFocus();
}
function browseActivate() {
  if (browse.langMenuOpen) { toggleBrowseLang(browse.langIdx); return; }
  if (browse.zone === 'lang') { openBrowseLangMenu(); return; }
  if (browse.zone === 'header') {
    var actions = [openCats, toggleBrowseDiscover, toggleBrowseHideBlocked, openBrowseLangMenu, closeBrowse];
    actions[browse.headerIdx](); return;
  }
  if (browse.zone === 'pins') {
    var pins = getPinnedCats(), pin = pins[browse.pinIdx - 1];
    if (!browse.pinIdx) clearBrowseCats(); else if (pin) toggleBrowseCat(pin.slug, pin.name);
    applyBrowseFocus(true); return;
  }
  if (browse.gridIdx >= browse.streams.length) { if (browse.error) loadBrowseMore(); return; }
  var s = browse.streams[browse.gridIdx];
  if (!s) return;
  var slug = (s.channel && s.channel.slug) || s.slug;
  if (slug) { closeBrowse(); play(slug); }
}
// The "+" on a browse card saves that streamer without leaving the popup.
function browseAddFavorite(slug) {
  if (!slug || isFavorite(slug)) return;
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
             query: '', results: null, error: false, searchError: false, searching: false, capped: false, closedAt: 0, scrollTop: 0, focusKey: null, zone: 'grid', headerIdx: 0 };
var CATS_LIMIT = 1024;
function catKey(c) { return c.catalogueTerminal ? '__state' : (c.all ? '__all' : c.slug); }
function getCatsGrid() {
  if (!catsGridView) catsGridView = new VirtualGrid(document.getElementById('cats-grid'), { columns: CATS_COLS, height: 233, onRender: function () {
    catsFocusEl = catalogueMountedFocus(catsGridView, cats.gridIdx, cats.zone === 'grid', catsCardBaseOf);
  } });
  return catsGridView;
}
function compactCat(c) { return { slug: c.slug || '', name: c.name || c.slug || '', viewers: c.viewers || 0, banner: c.banner || null }; }
function mergeCats(arr, replaceFirst) {
  var seen = {}, out = [], first = replaceFirst ? arr : cats.list, second = replaceFirst ? cats.list : arr;
  for (var pass = 0; pass < 2; pass++) {
    var list = pass ? second : first;
    for (var i = 0; i < list.length && out.length < CATS_LIMIT; i++) if (list[i].slug && !seen['$' + list[i].slug]) {
      seen['$' + list[i].slug] = true; out.push(compactCat(list[i]));
    }
  }
  cats.list = out; cats.capped = out.length >= CATS_LIMIT;
}
// The grid shows either the paginated list or, while searching, the API's
// category search results (identical item shape).
function displayedCats() { return cats.results || cats.list; }
var CATS_COLS = 4;
function setCatsStatus(msg) { document.getElementById('cats-status').textContent = msg || ''; }
function catBanner(c) {
  var b = c && c.banner;
  if (!b) return null;
  if (typeof b === 'string') return b;
  // `responsive` offers 294w up to 600w; the tile is 376px. Never fall through to
  // the raw `responsive` string — that is a srcset, not a URL.
  return pickSrcsetUrl(b.responsive, CARD_IMG_W) || b.url || b.src || null;
}
function openCats() {
  if (!browse.open) return;
  var warm = cats.list.length && Date.now() - (cats.loadedAt || cats.closedAt) < 300000;
  cats.open = true; cats.session++; cats.fetching = false; cats.searching = false; cats.refreshing = false;
  clearTimeout(browsePeekTimer);
  cats.zone = 'grid';
  document.getElementById('cats').className = ''; showCursor();
  if (warm) {
    var view = getCatsGrid(); view.container.scrollTop = cats.scrollTop; view.dirty = true;
    renderCats(true);
    if (cats.query) runCatsSearch(cats.query);
    else refreshCats();
    return;
  }
  cats.gridIdx = 0; cats.focusKey = null; cats.list = []; cats.page = 1; cats.hasMore = true;
  cats.error = false; cats.searchError = false; cats.capped = false; cats.query = ''; cats.results = null;
  document.getElementById('cats-search').value = '';
  getCatsGrid().clear(); renderCatsSkeletons(); setCatsStatus('Loading categories...'); loadCatsMore(true);
}
function refreshCats() {
  if (!cats.open || cats.refreshing) return;
  cats.refreshing = true; cats.error = false; cats.refreshError = false;
  renderCats(true);
  var ses = cats.session;
  serviceGet('/api/v1/subcategories?page=1&limit=32', function (err, data) {
    if (!cats.open || ses !== cats.session) return;
    cats.refreshing = false;
    if (err || !data || !Array.isArray(data.data)) { cats.error = true; cats.refreshError = true; renderCats(true); return; }
    cats.error = false; cats.refreshError = false; cats.loadedAt = Date.now(); mergeCats(data.data, true); renderCats(true);
  }, { priority: 2 });
}
function closeCats() {
  cats.open = false; cats.session++; cats.fetching = false; cats.searching = false; cats.refreshing = false;
  cats.closedAt = Date.now(); cats.scrollTop = document.getElementById('cats-grid').scrollTop;
  clearTimeout(catsSearchTimer);
  try { document.getElementById('cats-search').blur(); } catch (e) {}
  document.getElementById('cats').className = 'hidden';
  if (typeof flushChatRender === 'function') flushChatRender();
  scheduleBrowseFill();
}
// Static tiles preserve the catalogue geometry while the first page loads.
function renderCatsSkeletons() { catalogueSkeletons(getCatsGrid(), 'cats'); }
// Keep a bounded directory pool; the search endpoint can find categories beyond it.
function loadCatsMore(initial) {
  if (!cats.open || cats.fetching || !cats.hasMore || cats.query) return;
  cats.fetching = true; cats.error = false; cats.refreshError = false;
  if (cats.list.length) renderCats(true);
  var pg = cats.page, ses = cats.session;
  serviceGet('/api/v1/subcategories?page=' + pg + '&limit=32', function (err, data) {
    if (ses !== cats.session || !cats.open) return;
    cats.fetching = false;
    if (err || !data || !Array.isArray(data.data)) { cats.error = true; if (!cats.query) renderCats(true); return; }
    var arr = data.data, before = cats.list.length;
    mergeCats(arr, false); cats.loadedAt = Date.now(); cats.page = pg + 1;
    cats.hasMore = !!arr.length && cats.list.length > before && !cats.capped;
    if (!cats.query) renderCats(true);
    if (initial && cats.page <= 2 && cats.hasMore) loadCatsMore(true);
  }, { priority: 1 });
}
// Search across all of Kick's categories (the paginated list only holds what
// has been scrolled in so far).
var catsSearchTimer = null;
function runCatsSearch(q) {
  var ses = cats.session;
  cats.searching = true; cats.searchError = false;
  renderCats(true);
  serviceGet('/api/search?searched_word=' + encodeURIComponent(q), function (err, data) {
    if (ses !== cats.session || !cats.open || cats.query !== q) return;
    cats.searching = false;
    if (err || !data || !Array.isArray(data.categories)) { cats.searchError = true; renderCats(true); return; }
    cats.results = data.categories.slice(0, CATS_LIMIT).map(compactCat);
    renderCats();
  }, { priority: 1 });
}
function renderCats(preserveScroll) {
  var view = getCatsGrid(), saved = view.container.scrollTop;
  var items = [{ all: true }].concat(displayedCats());
  if (cats.query && cats.searchError) items.push(catalogueTerminal('cats', 'Could not search categories', true));
  else if (!cats.query && cats.error) items.push(catalogueTerminal('cats', 'Could not load categories', true));
  else if (cats.searching || (!cats.query && (cats.fetching || cats.refreshing))) items.push(catalogueTerminal('cats', 'Loading categories...'));
  else if (cats.query) items.push(catalogueTerminal('cats', displayedCats().length ? 'End of search results' : 'No categories match'));
  else if (!cats.hasMore) items.push(catalogueTerminal('cats', cats.capped ? 'Category limit reached · Search for more' : 'End of categories'));
  cats.gridIdx = catalogueIdentityIndex(items, catKey, cats.focusKey, cats.gridIdx);
  if (preserveScroll && cats.focusKey !== null) saved = catalogueAnchoredScroll(view, cats.gridIdx, cats.focusKey, saved);
  var flags = '|' + JSON.stringify(browse.cats) + '|' + JSON.stringify(getPinnedCats()) + '|' + JSON.stringify(getBlockedCats());
  function signature(c) { return JSON.stringify(c) + flags; }
  view.setItems(items, catKey, function (c, i) { var node = makeCatCard(c, i); node.__signature = signature(c); return node; }, function (node, c, i) {
    var sig = signature(c); if (node.__signature !== sig) { catalogueUpdate(node, makeCatCard(c, i)); node.__signature = sig; }
  });
  setCatsStatus(''); applyCatsFocus(!!preserveScroll);
  if (preserveScroll) { view.container.scrollTop = saved; view.refresh(); }
}
function makeCatCard(c, i) {
  if (c.catalogueTerminal) return makeCatalogueTerminal(c);
  var card = document.createElement('div'); card.className = 'ccard';
  var banner = document.createElement('div'); banner.className = c.all ? 'cbanner call' : 'cbanner';
  if (c.all) {
    // No artwork for "every category": a grid mark instead of an empty black tile.
    banner.innerHTML = '<svg class="callicon" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>';
  } else {
    catalogueImage(banner, catBanner(c), c.name || c.slug);
    var vw = document.createElement('span'); vw.className = 'cviewers';
    vw.innerHTML = '<span class="bdot"></span>'; vw.appendChild(document.createTextNode(fmtViewers(c.viewers || 0))); banner.appendChild(vw);
    var pin = document.createElement('span'); pin.className = 'catpin' + (isCatPinned(c.slug) ? ' on' : '');
    pin.setAttribute('data-act', 'catpin'); pin.setAttribute('title', 'Pin category'); pin.innerHTML = pinIcon(); banner.appendChild(pin);
    var block = document.createElement('span'); block.className = 'catblock' + (isCatBlocked(c.slug) ? ' on' : '');
    block.setAttribute('data-act', 'catblock'); block.setAttribute('title', 'Block category'); block.innerHTML = blockIcon(); banner.appendChild(block);
  }
  if (c.all ? !browse.cats.length : hasBrowseCat(c.slug)) {
    var tick = document.createElement('span'); tick.className = 'catsel'; tick.textContent = '✓'; banner.appendChild(tick);
  }
  var name = document.createElement('div'); name.className = 'cname'; name.textContent = c.all ? 'All categories' : (c.name || c.slug);
  card.appendChild(banner); card.appendChild(name); return card;
}
var catsFocusEl = null;
function catsCardBaseOf(card) { return card.getAttribute('data-base') || 'ccard'; }
function applyCatsFocus(preserveScroll) {
  var view = getCatsGrid(), el = cats.zone === 'grid' && !preserveScroll ? view.focus(cats.gridIdx) : view.get(cats.gridIdx);
  view.focused = cats.gridIdx;
  var item = view.items[cats.gridIdx]; cats.focusKey = item ? catKey(item) : null;
  catsFocusEl = swapFocus(view.content, catsFocusEl, el, catsCardBaseOf, cats.zone === 'grid');
  document.getElementById('cats-search').classList.toggle('focused', cats.zone === 'header' && cats.headerIdx === 0);
  document.getElementById('cats-close').classList.toggle('focused', cats.zone === 'header' && cats.headerIdx === 1);
}
function catsMove(dx, dy) {
  if (cats.zone === 'header') {
    if (dx) cats.headerIdx = Math.max(0, Math.min(1, cats.headerIdx + dx));
    if (dy > 0) { cats.zone = 'grid'; document.getElementById('cats-search').blur(); }
  } else if (dy < 0 && cats.gridIdx < CATS_COLS) cats.zone = 'header';
  else cats.gridIdx = catalogueMove(cats.gridIdx, getCatsGrid().items.length, CATS_COLS, dx, dy);
  applyCatsFocus();
  if (cats.zone === 'grid' && !cats.query && !cats.error && cats.gridIdx >= cats.list.length + 1 - 2 * CATS_COLS) loadCatsMore(false);
}
// OK toggles and the popup stays up, so several categories can be picked in one
// visit. Back is what closes it.
function catsActivate() {
  if (cats.zone === 'header') { if (cats.headerIdx) closeCats(); else document.getElementById('cats-search').focus(); return; }
  var item = getCatsGrid().items[cats.gridIdx];
  if (item && item.catalogueTerminal) {
    if (item.retry) { if (cats.query) runCatsSearch(cats.query); else if (cats.refreshError) refreshCats(); else { cats.hasMore = true; loadCatsMore(false); } }
    return;
  }
  if (cats.gridIdx === 0) { clearBrowseCats(); return; }
  var c = displayedCats()[cats.gridIdx - 1]; if (c) toggleBrowseCat(c.slug, c.name || c.slug);
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
var chipCountMemo = { key: null, raw: null, counts: null };   // recounted only when the pool or its filters change
function renderPinnedCatChips() {
  var box = document.getElementById('browse-pinnedcats');
  var panel = document.getElementById('browse-panel');
  if (!box) return;
  var l = getPinnedCats();
  if (!l.length) {
    box.innerHTML = ''; box.__signature = ''; box.className = 'hidden';
    if (browse.zone === 'pins') browse.zone = 'header';
    if (panel) panel.className = '';
    return;
  }
  box.className = '';
  if (panel) panel.className = 'haspins';   // the grid gives up a row of height
  // Live streams per category, counted under the SAME language and Discover
  // filters the grid uses — the number a chip shows is the number of cards
  // clicking it will yield. Re-rendered on every filter change.
  var hideFollowed = browse.discover;
  var countKey = [(browse.raw || []).length, settings.hideBots ? 1 : 0, browse.langs.join(','),
                  hideFollowed ? getFavorites().join(',') : ''].join('|');
  var counts = chipCountMemo.key === countKey && chipCountMemo.raw === browse.raw ? chipCountMemo.counts : null;
  if (!counts) {
    counts = {};
    var pool = browse.raw || [];
    for (var ri = 0; ri < pool.length; ri++) {
      var s = pool[ri];
      if (settings.hideBots && isBotStream(s)) continue;   // chips count what the grid will show
      if (browse.langs.length && browse.langs.indexOf(s.language) === -1) continue;
      if (hideFollowed && isFavorite((s.channel || {}).slug)) continue;
      var rc = s.categories && s.categories[0];
      if (rc && rc.slug) counts[rc.slug] = (counts[rc.slug] || 0) + 1;
    }
    chipCountMemo = { key: countKey, raw: browse.raw, counts: counts };
  }
  var chipSignature = JSON.stringify(l) + '|' + JSON.stringify(counts) + '|' + JSON.stringify(browse.cats);
  if (box.__signature === chipSignature) return;
  box.__signature = chipSignature;
  var savedLeft = box.scrollLeft;
  box.innerHTML = '';
  var all = document.createElement('span');
  all.className = 'pcat' + (browse.cats.length ? '' : ' sel');
  all.textContent = 'All';
  all.setAttribute('data-cslug', '');
  box.appendChild(all);
  for (var i = 0; i < l.length; i++) {
    var chip = document.createElement('span');
    chip.className = 'pcat' + (hasBrowseCat(l[i].slug) ? ' sel' : '');
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
  browse.pinIdx = Math.min(browse.pinIdx, l.length);
  box.scrollLeft = savedLeft;
  if (browseGridView) { browseGridView.dirty = true; browseGridView.schedule(); }
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
  if (browse.open) renderBrowse(); // the grid hides blocked categories, so the set moved under it
  if (cats.open) renderCats();
  if (settings.open) renderSettings();
}

/* When we last saw each followed channel live, and when this install first ran.
   Both only ever feed the offline line in the channel list. Two honest limits:
   the baseline is stamped the first time this build runs, not the real install
   date, and the elapsed time is measured from when WE last saw the channel live —
   a channel that streamed while the TV was off reads longer than it truly was.
   Reading it from Kick instead would cost one request per offline channel and
   returns nothing once old recordings are pruned. */
var LASTLIVE_KEY = 'kicktv.lastlive';
var FIRSTRUN_KEY = 'kicktv.firstrun';
var LASTLIVE_LIMIT = 200;   // bounded by the follow list in practice; this is just insurance
var lastLiveMemo = null;
function getLastLive() {
  if (lastLiveMemo) return lastLiveMemo;
  var v = null;
  try { v = JSON.parse(localStorage.getItem(LASTLIVE_KEY)); } catch (e) {}
  lastLiveMemo = (v && typeof v === 'object' &&
                  Object.prototype.toString.call(v) !== '[object Array]') ? v : {};
  return lastLiveMemo;
}
function noteLive(slugs) {
  if (!slugs || !slugs.length) return;
  var m = getLastLive(), now = Date.now(), i;
  for (i = 0; i < slugs.length; i++) m[slugs[i]] = now;
  var keys = Object.keys(m);
  if (keys.length > LASTLIVE_LIMIT) {
    keys.sort(function (a, b) { return m[a] - m[b]; });      // oldest first
    while (keys.length > LASTLIVE_LIMIT) delete m[keys.shift()];
  }
  try { localStorage.setItem(LASTLIVE_KEY, JSON.stringify(m)); } catch (e) {}
}
function getFirstRun() {
  var v = 0;
  try { v = parseInt(localStorage.getItem(FIRSTRUN_KEY), 10); } catch (e) {}
  if (!isFinite(v) || v <= 0) {
    v = Date.now();
    try { localStorage.setItem(FIRSTRUN_KEY, String(v)); } catch (e) {}
  }
  return v;
}
var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// toLocaleDateString is not dependable on this build, so format by hand.
function fmtShortDate(ms) {
  var d = new Date(ms);
  return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()];
}
function fmtOfflineFor(ms) {
  var days = Math.floor(ms / 86400000);
  if (days < 60) return days + (days === 1 ? ' day' : ' days');
  var months = Math.floor(days / 30);
  return months + (months === 1 ? ' month' : ' months');
}
// Under a day reads plain "Offline" — nobody needs telling a channel has been off
// since this morning. The never-seen line drops the "Offline · " prefix: with it,
// the text overran the row and ellipsised away the very date it exists to show.
function offlineLabel(slug) {
  var ts = getLastLive()[slug];
  if (ts) {
    var ago = Date.now() - ts;
    if (ago < 86400000) return 'Offline';
    return 'Offline for ' + fmtOfflineFor(ago);
  }
  return 'Never live since ' + fmtShortDate(getFirstRun());
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
var vodProgressMemo = null, vodProgressSerialized = null;
function loadVodProgress() {
  if (vodProgressMemo) return vodProgressMemo;
  try {
    vodProgressSerialized = localStorage.getItem(VOD_PROGRESS_KEY);
    var data = JSON.parse(vodProgressSerialized);
    if (data && data.version === 1 && data.items && typeof data.items === 'object') return (vodProgressMemo = data);
  } catch (e) {}
  return (vodProgressMemo = { version: 1, items: {} });
}
function writeVodProgress(data) {
  vodProgressMemo = data;
  try {
    var keys = Object.keys(data.items);
    if (keys.length > VOD_PROGRESS_LIMIT) {
      keys.sort(function (a, b) {
        return (data.items[a].updated || 0) - (data.items[b].updated || 0);
      });
      while (keys.length > VOD_PROGRESS_LIMIT) delete data.items[keys.shift()];
    }
    var serialized = JSON.stringify(data);
    if (serialized !== vodProgressSerialized) {
      localStorage.setItem(VOD_PROGRESS_KEY, serialized);
      vodProgressSerialized = serialized;
    }
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
  if (entry && entry.watched) return 0;     // the card says Watched, so it starts over
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
  var durSec = Math.floor(vodDurationMs(matched) / 1000);
  // Watched most of it live? Then the recording is watched, and like any finished
  // video it keeps no resume point — a rewatch starts from the beginning.
  if (durSec > 0 && (mark.watchedSec || 0) / durSec >= LIVEMARK_WATCHED_FRAC) {
    progress.items[key] = {
      position: 0, duration: durSec, updated: now,
      name: mark.name, title: mark.title, watched: true
    };
    writeVodProgress(progress);
    clearLiveMark(slug);
    return true;
  }
  var pos = positionForMark(mark, matched);
  if (!(pos >= 10)) { clearLiveMark(slug); return false; }          // nothing worth resuming
  progress.items[key] = {
    position: pos,
    duration: durSec,
    updated: now,
    name: mark.name,
    title: mark.title
  };
  writeVodProgress(progress);
  clearLiveMark(slug);
  return true;
}
var LIVEMARK_WATCHED_FRAC = 0.8;   // watched this much of the stream -> the recording is watched
var LIVEMARK_TICK_GAP_MS = 5000;   // a longer gap than this was not viewing time
var liveWatchStartedMs = 0;   // when the current live playback began
var liveMarkLastWrite = 0;
var liveWatchCountedMs = 0;   // time already counted towards the running total
var liveWatchAccumSec = 0;    // seconds actually watched in this session
var liveWatchSeeded = false;  // has the stored total been folded in yet
var liveWatchContentMs = 0;   // wall-clock moment of the stream frame last seen playing
// How far behind the live edge the picture is, in seconds.
function liveLatencySec() {
  var video = document.getElementById('video'), lat = NaN;
  try { if (state.hls) lat = state.hls.latency; } catch (e) {}
  if (typeof lat !== 'number' || !isFinite(lat) || lat < 0) {
    var r = liveSeekRange(video);
    lat = r ? Math.max(0, r.end - (video.currentTime || 0)) : 0;
  }
  return lat;
}
// Called on every timeupdate, which only fires while the video is progressing.
// Counting here rather than at write time keeps paused, hidden and asleep
// stretches out of the total, and each step is small enough to be trustworthy.
function tickLiveWatch() {
  var now = Date.now();
  if (!liveWatchStartedMs) { liveWatchCountedMs = now; return; }
  var since = now - (liveWatchCountedMs || liveWatchStartedMs);
  liveWatchCountedMs = now;
  var video = document.getElementById('video');
  if (video && !video.paused && since > 0 && since < LIVEMARK_TICK_GAP_MS) {
    liveWatchAccumSec += since / 1000;
  }
  // Only moves while frames do, so a pause holds the mark where the picture stopped.
  if (video && !video.paused) liveWatchContentMs = now - liveLatencySec() * 1000;
}
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
  if (!startedMs || !liveWatchContentMs) return;
  // Where the PICTURE was, not what the clock says: a pause, or simply sitting
  // behind the live edge, must not push the recording's resume point forward.
  var seenMs = Math.min(now, liveWatchContentMs);
  var offsetSec = Math.floor((seenMs - startedMs) / 1000);
  if (!(offsetSec >= 10)) return;
  liveMarkLastWrite = now;
  var data = loadLiveMarks();
  // Fold in what a previous sitting already banked for this same session, once
  // per playback, so leaving and coming back keeps adding up rather than restarting.
  if (!liveWatchSeeded) {
    liveWatchSeeded = true;
    var prev = data.items[slug];
    if (prev && prev.sessionStartedAt === c.startedAt) liveWatchAccumSec += (prev.watchedSec || 0);
  }
  data.items[slug] = {
    sessionStartedAt: c.startedAt,
    leftAtMs: seenMs,
    offsetSec: offsetSec,
    watchedSec: Math.floor(liveWatchAccumSec),
    name: c.name || slug,
    title: c.title || '',
    updated: now
  };
  writeLiveMarks(data);
}

function saveVodProgress(force) {
  if (!state.vod || !state.vod.key || state.vod.liveRewind) return;
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
  var nextPosition = pos < 10 ? 0 : Math.floor(pos);
  var nextDuration = isFinite(dur) && dur > 0 ? Math.floor(dur) : 0;
  if (prev && prev.position === nextPosition && prev.duration === nextDuration &&
      !!prev.watched === watched) return;
  if (!prev && pos < 10 && !watched) return;
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
  if (!state.vod || state.vod.liveRewind) return;
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
var vods = { open: false, slug: '', gridIdx: 0, list: [], loading: false, hidden: 0, session: 0, error: false, capped: false, zone: 'grid', headerIdx: 0, focusKey: null };
var VOD_CATALOGUE_LIMIT = 400;
var vodCatalogueCache = {}, vodCatalogueOrder = [];
function vodCatalogueKey(v) { return v.catalogueTerminal ? '__state' : (vodStableId(v) || String(v.created_at || '') + '|' + String(v.source || '')); }
function getVodGrid() {
  if (!vodGridView) vodGridView = new VirtualGrid(document.getElementById('vods-grid'), { columns: VOD_COLS, height: 366, onRender: function () {
    vodsFocusEl = catalogueMountedFocus(vodGridView, vods.gridIdx, vods.zone === 'grid', vodCardBaseOf);
  } });
  return vodGridView;
}
function rememberVodCatalogue() {
  if (!vods.slug || !vods.listAll || !vods.loadedAt) return;
  var slug = vods.slug, at = vodCatalogueOrder.indexOf(slug);
  if (at !== -1) vodCatalogueOrder.splice(at, 1); vodCatalogueOrder.push(slug);
  vodCatalogueCache['$' + slug] = { list: vods.listAll, hidden: vods.hidden, capped: vods.capped, loadedAt: vods.loadedAt,
    focusKey: vods.focusKey, gridIdx: vods.gridIdx, scrollTop: document.getElementById('vods-grid').scrollTop };
  while (vodCatalogueOrder.length > 4) delete vodCatalogueCache['$' + vodCatalogueOrder.shift()];
}
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
  return { watched: watched, frac: watched ? 1 : frac,
           position: !watched && isFinite(ppos) && ppos >= 10 ? Math.floor(ppos) : 0 };
}
function loadVodHideWatchedPref() {
  try { return localStorage.getItem('kicktv.vodhidewatched') === '1'; } catch (e) { return false; }
}
function applyVodFilter() {
  var identity = vods.list[vods.gridIdx] ? vodCatalogueKey(vods.list[vods.gridIdx]) : vods.focusKey;
  if (!vods.hideWatched) vods.list = vods.listAll.slice();
  else {
    var items = loadVodProgress().items; vods.list = [];
    for (var i = 0; i < vods.listAll.length; i++) if (!vodWatchedInfo(vods.slug, vods.listAll[i], items).watched) vods.list.push(vods.listAll[i]);
  }
  vods.gridIdx = catalogueIdentityIndex(vods.list, vodCatalogueKey, identity, vods.gridIdx);
}
function renderVodFilterChip() {
  var el = document.getElementById('vods-filter');
  if (el) el.className = vods.hideWatched ? 'on' : '';
}
function toggleVodHideWatched() {
  vods.hideWatched = !vods.hideWatched;
  try { localStorage.setItem('kicktv.vodhidewatched', vods.hideWatched ? '1' : '0'); } catch (e) {}
  applyVodFilter(); renderVods(); renderVodFilterChip(); applyVodFocus(true);
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
  var t = parseKickTime(str);
  if (!t) return '';
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
  var months = Math.floor(days / 30);
  if (months < 12) return n(months, 'month');
  return n(Math.max(1, Math.floor(days / 365)), 'year');
}
// minWidth shrinks the pick for the grid. The full-screen poster passes nothing and
// keeps the 1280-wide `src`: a 480-wide still stretched across 1920px looks soft.
function vodThumb(v, minWidth) {
  var t = v && v.thumbnail;
  if (t) {
    if (minWidth) {
      var u = pickSrcsetUrl(t.srcset, minWidth);
      if (u) return u;
    }
    if (t.src) return t.src;
  }
  if (v && v.video && v.video.thumb && v.video.thumb.src) return v.video.thumb.src;
  return null;
}
function openVods(slug) {
  if (!state.ready || !slug) return;
  if (browse.open) closeBrowse();
  if (settings.open) closeSettings();
  if (vods.open) rememberVodCatalogue();
  var oldSlug = vods.slug, cached = vodCatalogueCache['$' + slug];
  var warm = cached && Date.now() - cached.loadedAt < 300000;
  vods.open = true; vods.session++; vods.slug = slug; vods.zone = 'grid'; vods.error = false;
  vods.loading = false; vods.hideWatched = loadVodHideWatchedPref();
  state.vodReturn = state.current || state.vodReturn;
  showCursor(); closeSidebar(); pausePlaybackForBrowse();
  document.getElementById('vods').className = '';
  var name = (state.channels[slug] && state.channels[slug].name) || slug;
  document.getElementById('vods-title').textContent = 'Past videos - ' + name;
  renderVodFilterChip();
  var view = getVodGrid(); view.dirty = true;
  if (warm) {
    vods.listAll = cached.list; vods.list = []; vods.hidden = cached.hidden; vods.capped = cached.capped; vods.loadedAt = cached.loadedAt;
    vods.gridIdx = cached.gridIdx; vods.focusKey = cached.focusKey;
    applyVodFilter();
    if (oldSlug !== slug) view.clear();
    view.container.scrollTop = cached.scrollTop;
    renderVods(true); view.container.scrollTop = cached.scrollTop; view.refresh();
    loadVods(true);
  } else {
    vods.listAll = []; vods.list = []; vods.gridIdx = 0; vods.focusKey = null; vods.hidden = 0; vods.capped = false; vods.loadedAt = 0;
    view.clear(); catalogueSkeletons(view, 'vod'); setVodStatus('Loading past videos...'); loadVods(false);
  }
}
function loadVods(quiet) {
  if (!vods.open || vods.loading) return;
  var ses = vods.session, slug = vods.slug;
  vods.loading = true; vods.error = false;
  if (!quiet && vods.listAll.length) renderVods(true);
  serviceGet('/api/v2/channels/' + encodeURIComponent(slug) + '/videos', function (err, data) {
    if (ses !== vods.session || !vods.open || slug !== vods.slug) return;
    vods.loading = false;
    if (err || !Array.isArray(data)) { vods.error = true; renderVods(true); return; }
    var all = [], hidden = 0, seen = {};
    for (var i = 0; i < data.length; i++) {
      var src = data[i];
      if (!src || !playableVod(src)) { hidden++; continue; }
      var key = vodCatalogueKey(src);
      if (seen['$' + key]) continue; seen['$' + key] = true;
      if (all.length < VOD_CATALOGUE_LIMIT) all.push({ id: src.id, uuid: src.uuid, video: src.video ? { id: src.video.id, uuid: src.video.uuid, thumb: src.video.thumb } : null,
        source: src.source, session_title: src.session_title || '', duration: src.duration || 0, views: src.views || 0,
        thumbnail: src.thumbnail || null, categories: src.categories && src.categories[0] ? [{ name: src.categories[0].name || '', slug: src.categories[0].slug || '' }] : [],
        created_at: src.created_at || '', is_live: !!src.is_live });
    }
    vods.listAll = all; vods.hidden = hidden; vods.capped = data.length - hidden > VOD_CATALOGUE_LIMIT; vods.loadedAt = Date.now();
    try { resolveLiveMark(slug, vods.listAll); } catch (e) {}
    applyVodFilter(); renderVods(!!quiet); rememberVodCatalogue();
  }, { priority: quiet ? 2 : 1 });
}
function closeVods() {
  rememberVodCatalogue(); vods.open = false; vods.session++; vods.loading = false;
  document.getElementById('vods').className = 'hidden';
  if (typeof flushChatRender === 'function') flushChatRender();
  if (state.current || state.vod) resumePlaybackAfterBrowse();
}
function renderVods(preserveScroll) {
  var view = getVodGrid(), saved = view.container.scrollTop, items = vods.list.slice();
  if (preserveScroll && vods.focusKey !== null) saved = catalogueAnchoredScroll(view, vods.gridIdx, vods.focusKey, saved);
  if (vods.error) items.push(catalogueTerminal('vod', 'Could not load past videos', true));
  else if (vods.loading) items.push(catalogueTerminal('vod', 'Loading past videos...'));
  else if (items.length) items.push(catalogueTerminal('vod', vods.capped ? 'Showing the latest ' + VOD_CATALOGUE_LIMIT + ' past videos' : 'End of past videos'));
  var progress = loadVodProgress().items;
  function signature(v) { return JSON.stringify(v) + '|' + JSON.stringify(progress[vodProgressKey(vods.slug, v)] || null); }
  view.setItems(items, vodCatalogueKey, function (v, i) { var node = v.catalogueTerminal ? makeCatalogueTerminal(v) : makeVodCard(v, i, progress); node.__signature = signature(v); return node; }, function (node, v, i) {
    var sig = signature(v); if (node.__signature !== sig) { catalogueUpdate(node, v.catalogueTerminal ? makeCatalogueTerminal(v) : makeVodCard(v, i, progress)); node.__signature = sig; }
  });
  vods.gridIdx = Math.max(0, Math.min(items.length - 1, vods.gridIdx));
  if (!items.length) vods.zone = 'header';
  setVodStatus(items.length ? '' : (vods.listAll.length ? 'All watched · Green shows them' : (vods.hidden ? 'No playable past videos' : 'No past videos')));
  applyVodFocus(!!preserveScroll);
  if (preserveScroll) { view.container.scrollTop = saved; view.refresh(); }
}
function makeVodCard(v, i, progress) {
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
    var url = vodThumb(v, CARD_IMG_W);
    var thumbImage = document.createElement('div');
    thumbImage.className = 'vodthumb-image';
    catalogueImage(thumbImage, url, v.session_title || 'Past video');
    thumb.appendChild(thumbImage);
    var dur = document.createElement('span');
    dur.className = 'bdur';
    // The stream still running is in this list too, with a duration of 0. Saying
    // "0:00" reads like an empty recording; it is simply not finished yet.
    dur.textContent = v.is_live ? 'In progress' : fmtDuration(v.duration);
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
    if (w.position > 0) {
      var resume = document.createElement('span');
      resume.className = 'bresume';
      resume.textContent = 'Resume · ' + fmtClock(w.position);
      meta.children[2].appendChild(resume);
    }
    card.appendChild(meta);
    return card;
}
var vodsFocusEl = null;
// data-base carries the watched dimming, so a card must not lose it on unfocus
function vodCardBaseOf(vcard) { return vcard.getAttribute('data-base') || 'bcard'; }
function applyVodFocus(preserveScroll) {
  var view = getVodGrid(), el = vods.zone === 'grid' && !preserveScroll ? view.focus(vods.gridIdx) : view.get(vods.gridIdx);
  view.focused = vods.gridIdx;
  var item = view.items[vods.gridIdx]; vods.focusKey = item ? vodCatalogueKey(item) : null;
  vodsFocusEl = swapFocus(view.content, vodsFocusEl, el, vodCardBaseOf, vods.zone === 'grid');
  document.getElementById('vods-filter').classList.toggle('focused', vods.zone === 'header' && vods.headerIdx === 0);
  document.getElementById('vods-close').classList.toggle('focused', vods.zone === 'header' && vods.headerIdx === 1);
}
function vodMove(dx, dy) {
  if (vods.zone === 'header') {
    if (dx) vods.headerIdx = Math.max(0, Math.min(1, vods.headerIdx + dx));
    if (dy > 0 && getVodGrid().items.length) vods.zone = 'grid';
  } else if (dy < 0 && vods.gridIdx < VOD_COLS) vods.zone = 'header';
  else vods.gridIdx = catalogueMove(vods.gridIdx, getVodGrid().items.length, VOD_COLS, dx, dy);
  applyVodFocus();
}
function vodActivate() {
  if (vods.zone === 'header') { if (vods.headerIdx) closeVods(); else toggleVodHideWatched(); return; }
  if (vods.gridIdx >= vods.list.length) { if (vods.error) loadVods(false); return; }
  rememberVodCatalogue();
  var v = vods.list[vods.gridIdx];
  if (v && v.source) {
    vods.open = false;
    document.getElementById('vods').className = 'hidden';
    // Capture this exact list as the auto-advance queue. The global VOD browser
    // can later be opened for another streamer without changing what comes next.
    playVod(v, vods.list.slice(), vods.gridIdx, vods.slug);
  }
}
function playVod(v, queue, queueIndex, slug, opts) {
  var liveRewind = !!(opts && opts.liveRewind);
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
  var resumeAt = liveRewind ? opts.resumeAt : savedVodPosition(progressKey);
  var savedEntry = liveRewind ? null : loadVodProgress().items[progressKey];
  var knownDuration = (savedEntry && savedEntry.duration) || (v.duration || 0) / 1000 || 0;
  // A running stream's recording lists no duration; it is as long as the stream so far.
  if (liveRewind && !knownDuration && opts.recStartMs) knownDuration = Math.max(0, (Date.now() - opts.recStartMs) / 1000);
  vodProgressLastWrite = 0;
  state.vod = { slug: vodSlug, source: v.source,
                title: v.session_title || 'Past video',
                name: (state.channels[vodSlug] && state.channels[vodSlug].name) || vodSlug,
                queue: playQueue, queueIndex: playIndex,
                markerId: vodStableId(v),
                poster: vodThumb(v),      // shown while the first frame decodes

                key: progressKey, resumeAt: resumeAt, resumeApplied: false,
                knownDuration: knownDuration,
                progressReady: false, completed: false, ending: false, retries: 0,
                // Rewound live: temporary, so no progress, no Continue Watching, no
                // startup recovery; its end is the live edge, not "video ended".
                liveRewind: liveRewind,
                wallTarget: liveRewind ? opts.wallTarget : 0,
                recStartMs: liveRewind ? opts.recStartMs : 0, recEndMs: 0 };
  applyStreamerChatPreferences();
  if (!liveRewind) saveLastVod(vodSlug, v, state.vod.name);
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
  setPosterStill(state.vod && state.vod.poster);   // also covers a reload
  if (window.Hls && Hls.isSupported()) {
    var hls = new Hls(withTvGuards({
      enableWorker: true, capLevelToPlayerSize: true, maxBufferLength: 30,
      // hls.js keeps everything behind the playhead by default. On a four-hour VOD
      // that grows until the TV's MSE quota starts force-evicting, which shows up as
      // stalls late in a long watch. maxBufferSize only gates what is loaded ahead.
      backBufferLength: 30,
      manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6,
      startPosition: state.vod && state.vod.resumeAt > 0 ? state.vod.resumeAt : -1
    }));
    state.hls = hls;
    qualityAlertReset();
    hls.on(Hls.Events.ERROR, function (ev, data) {
      if (data && data.details) PB.lastError = data.details;
      if (state.hls !== hls || !data || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        // A buffer that was never created cannot be recovered in place — see onMediaError.
        if (data.details === 'bufferAppendError') { reloadVod(); }
        // in-place recovery is not free: after a few consecutive failures fall
        // through to reloadVod so its bounded retry/exit ceiling applies
        else {
          if (state.vod) state.vod.mediaRecoveries = (state.vod.mediaRecoveries || 0) + 1;
          if (state.vod && state.vod.mediaRecoveries > MAX_MEDIA_RETRY) reloadVod();
          else { try { hls.recoverMediaError(); } catch (e) { reloadVod(); } }
        }
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
        if (state.hls === hls) { updateQualityButton(); checkQualityDrop(); }
      });
    }
    if (Hls.Events.FRAG_LOADED) {
      hls.on(Hls.Events.FRAG_LOADED, function (ev, d) { diagCountFrag(d); });
    }
    if (state.vod && state.vod.liveRewind && Hls.Events.LEVEL_LOADED) {
      hls.on(Hls.Events.LEVEL_LOADED, function (ev, d) { liveRewindLevelLoaded(hls, d); });
    }
    try { hls.loadSource(source); hls.attachMedia(video); }
    catch (e) { reloadVod(); return; }
  } else {
    try { video.src = source; } catch (e) { toast('Cannot play this video'); exitVod(); return; }
  }
  PB.active = true;
  playVideo(video);
}
// Every segment of a live recording carries its wall-clock time. The first one
// pins where the recording starts, which turns the requested moment into an
// exact position (created_at alone is a few seconds off).
function liveRewindLevelLoaded(hls, d) {
  var v = state.vod;
  if (state.hls !== hls || !v || !v.liveRewind) return;
  var det = d && d.details, frags = det && det.fragments;
  var pdt = frags && frags.length && frags[0].programDateTime;
  if (!(pdt > 0)) return;
  v.recStartMs = pdt;
  if (det.totalduration > 0) v.recEndMs = pdt + det.totalduration * 1000;
  if (v.wallTarget && !v.resumeApplied) v.resumeAt = Math.max(0, (v.wallTarget - pdt) / 1000);
  v.wallTarget = 0;              // a later reload resumes from the playhead, not this target
}
function reloadVod() {
  if (!state.vod) return;
  resetVodRecovery();
  var video = document.getElementById('video');
  if (isFinite(video.currentTime) && video.currentTime > 0) state.vod.resumeAt = Math.max(0, video.currentTime - 1);
  state.vod.retries = (state.vod.retries || 0) + 1;
  PB.reconnects++;
  if (state.vod.retries > 4) { toast('Playback error'); exitVod(); return; }
  setBanner('Reconnecting...');
  attachVod(state.vod.source);
}
function resetVodRecovery() {
  if (!state.vod) return;
  state.vod.recoveryTime = null;
  state.vod.recoveryAt = 0;
  state.vod.healthySeconds = 0;
}
// A 'playing' event alone can precede another immediate failure. Renew the
// consecutive-failure budget only after ten seconds of actual playback progress.
function trackVodRecovery() {
  var vod = state.vod, video = document.getElementById('video');
  if (!vod || (!vod.retries && !vod.mediaRecoveries)) return;
  if (video.paused || video.seeking || !isFinite(video.currentTime)) { resetVodRecovery(); return; }
  var now = Date.now(), pos = video.currentTime;
  var elapsed = (now - vod.recoveryAt) / 1000;
  var advanced = pos - vod.recoveryTime;
  if (typeof vod.recoveryTime === 'number' && elapsed > 0 && elapsed <= 2 &&
      advanced > 0 && advanced <= elapsed * (video.playbackRate || 1) + 0.5) {
    vod.healthySeconds += Math.min(elapsed, advanced);
  } else vod.healthySeconds = 0;
  vod.recoveryTime = pos;
  vod.recoveryAt = now;
  if (vod.healthySeconds >= 10) { vod.retries = 0; vod.mediaRecoveries = 0; resetVodRecovery(); }
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
  else { state.current = null; applyStreamerChatPreferences(); updateGear(); showNothing(); }
}
/* Rapid seek presses accumulate (+30, +60, +90...) and apply as one jump after
   a short pause, YouTube-style. Nothing actually seeks until the timeout, so
   the skip buttons stay on screen while you keep pressing. */
var seekAccum = { delta: 0, timer: null, baseTime: null };
var SEEK_APPLY_MS = 1000;
var vodSeekKey = { key: 0, started: 0, last: 0 };
function seekVodKey(key, repeat) {
  var now = Date.now();
  if (!repeat || vodSeekKey.key !== key) {
    vodSeekKey.key = key;
    vodSeekKey.started = now;
  } else if (now - vodSeekKey.last < 150) return;
  vodSeekKey.last = now;
  var held = now - vodSeekKey.started;
  var step = held >= 3000 ? 120 : (held >= 1000 ? 60 : 30);
  focusVodBar();
  seekVod(key === KEY.LEFT ? -step : step);
}
function seekVod(delta) {
  var video = document.getElementById('video');
  var d = video.duration;
  if (!state.vod || !d || isNaN(d)) return;
  if (seekAccum.baseTime === null) seekAccum.baseTime = video.currentTime || 0;
  seekAccum.delta += delta;
  var el = document.getElementById('seekpop');
  // A fresh value restarts the small pulse without forcing a layout read.
  var amount = document.createElement('span');
  amount.className = 'seekvalue';
  amount.textContent = (seekAccum.delta >= 0 ? '+' : '-') + Math.abs(seekAccum.delta) + 's';
  el.textContent = '';
  el.appendChild(amount);
  var destination = document.createElement('span');
  destination.className = 'seekdestination';
  var target = Math.max(0, Math.min(d - 1, seekAccum.baseTime + seekAccum.delta));
  destination.textContent = 'Jump to ' + fmtClock(target);
  el.appendChild(destination);
  el.style.setProperty('--seek-wait', SEEK_APPLY_MS + 'ms');
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
  vodSeekKey.key = 0;
  clearTimeout(seekAccum.timer);
  seekAccum.timer = null;
  seekAccum.delta = 0; seekAccum.baseTime = null;
  var el = document.getElementById('seekpop');
  if (el) el.className = 'hidden';
  document.getElementById('vodbar-origin').setAttribute('visibility', 'hidden');
}
var vodOverlayKey = '', vodOverlayFrame = null;
function requestVodOverlay() {
  if (vodOverlayFrame !== null) return;
  vodOverlayFrame = requestAnimationFrame(function () {
    vodOverlayFrame = null;
    if (Date.now() >= state.suppressNudgeUntil && !anyPanelOpen()) showVodOverlay();
  });
}
function showVodOverlay() {
  if (!state.vod) return;
  var player = document.getElementById('player');
  player.setAttribute('data-vod', '1');
  player.style.setProperty('--vod-left', state.sidebarOpen ? '530px' : '60px');
  document.getElementById('vod-scrim').className = '';
  var ov = document.getElementById('overlay');
  var vc = state.channels[state.vod.slug];
  var signature = [state.vod.slug, state.vod.title, state.vod.name, vc && vc.avatar, state.vod.liveRewind].join('|');
  if (signature !== vodOverlayKey) {
    vodOverlayKey = signature;
  setOverlayAvatar(vc && vc.avatar, state.vod.name);
  document.getElementById('ov-name').textContent = state.vod.name;
  document.getElementById('ov-live').style.display = 'none';
  document.getElementById('ov-viewers').textContent = state.vod.liveRewind ? 'Rewound live stream' : 'Past video';
  document.getElementById('ov-title').textContent = state.vod.title;
  }
  ov.className = '';
  showVodBar();
  showVodPlay();
  armVodOverlayHide();
}
function armVodOverlayHide() {
  clearTimeout(overlayTimer);
  if (vodPointerHover || vodDragging) return;
  overlayTimer = setTimeout(function () {
    if (state.sidebarOpen) return;   // sidebar is up: the whole UI hides together when it closes
    hideVodControls();
  }, 4000);
}
// Redraw the timeline and any pending seek preview a couple of times a second.
var vodbarTimer = null;
var vodDragging = false;
var vodPointerHover = '';    // only actual pointer interaction holds the controls open
/* Up explicitly enters transport navigation. Pointer hover and a quick OK still
   highlight controls without taking Left/Right away from direct seeking. */
var vodFocus = '';           // '', 'bar' or 'buttons'
var vodButtonNav = false;
var vodBtnIdx = 1;           // 0 rewind, 1 play/pause, 2 forward
// Go live (index 3) sits at the right end of the seek bar, and only while rewound.
var VOD_BTN_IDS = ['vodback', 'vodplay', 'vodfwd', 'vodgolive'];
function vodBtnCount() { return state.vod && state.vod.liveRewind ? 4 : 3; }
function applyVodCtrlFocus() {
  var bar = document.getElementById('vodbar');
  if (bar && bar.className.indexOf('hidden') === -1) {
    bar.className = vodFocus === 'bar' ? 'focused' : '';
  }
  for (var i = 0; i < VOD_BTN_IDS.length; i++) {
    var el = document.getElementById(VOD_BTN_IDS[i]);
    if (!el || el.className.indexOf('hidden') !== -1) continue;
    el.className = (vodFocus === 'buttons' && i === vodBtnIdx) ? 'focused' : '';
  }
}
function focusVodBar() {
  if (!state.vod) return;
  vodButtonNav = false;
  vodFocus = 'bar';
  showVodOverlay();          // shows the bar and buttons, resets the hide timer
  applyVodCtrlFocus();
}
// idx is optional: the D-pad lands on play/pause, the pointer lands on whichever
// button it is actually over.
function focusVodButtons(idx) {
  if (!state.vod) return;
  vodFocus = 'buttons';
  vodBtnIdx = (typeof idx === 'number') ? idx : 1;
  showVodOverlay();
  applyVodCtrlFocus();
}
function blurVodFocus() {
  vodButtonNav = false;
  vodFocus = '';
  applyVodCtrlFocus();
}
function vodBtnMove(d) {
  var n = vodBtnIdx + d;
  if (n < 0 || n >= vodBtnCount()) return;
  vodBtnIdx = n;
  showVodOverlay();          // keep the controls alive while moving between them
  applyVodCtrlFocus();
}
function vodBtnActivate() {
  if (vodBtnIdx === 0) seekVod(-30);
  else if (vodBtnIdx === 2) seekVod(30);
  else if (vodBtnIdx === 3) goLive();
  else toggleVodPlay();
}
// Showing at all, focused or not.
function vodBarVisible() {
  var el = document.getElementById('vodbar');
  return !!el && el.className.indexOf('hidden') === -1;
}
// Dismiss the whole VOD control set when the overlay times out.
function hideVodControls() {
  if (vodOverlayFrame !== null) { cancelAnimationFrame(vodOverlayFrame); vodOverlayFrame = null; }
  document.getElementById('overlay').className = 'hidden';
  hideVodPlay();
  hideVodBar();              // clears vodFocus
}
function fmtClock(sec) { return fmtDuration((sec || 0) * 1000); }
function changedAttr(el, name, value) {
  value = String(value);
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function changedText(el, value) { if (el.textContent !== value) el.textContent = value; }
function drawVodBar(cur, dur, origin) {
  var W = 1500, mid = 20;
  var prog = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0;
  var px = prog * W;
  // A focused bar gets a chunkier play head.
  var hw = vodFocus === 'bar' ? 14 : 8;
  var hh = vodFocus === 'bar' ? 38 : 30;
  var hy = vodFocus === 'bar' ? 1 : 5;
  changedAttr(document.getElementById('vodbar-played'), 'd', 'M0,' + mid + ' L' + px.toFixed(1) + ',' + mid);
  changedAttr(document.getElementById('vodbar-remain'), 'x1', px.toFixed(1));
  var handle = document.getElementById('vodbar-handle');
  changedAttr(handle, 'width', hw);
  changedAttr(handle, 'height', hh);
  changedAttr(handle, 'y', hy);
  changedAttr(handle, 'x', (px - hw / 2).toFixed(1));
  var originEl = document.getElementById('vodbar-origin');
  var pending = typeof origin === 'number' && isFinite(origin) && dur > 0;
  changedAttr(originEl, 'visibility', pending ? 'visible' : 'hidden');
  if (pending) {
    var ox = (Math.max(0, Math.min(1, origin / dur)) * W).toFixed(1);
    changedAttr(originEl, 'x1', ox);
    changedAttr(originEl, 'x2', ox);
  }
  changedText(document.getElementById('vodbar-cur'), fmtClock(cur));
  changedText(document.getElementById('vodbar-dur'), fmtClock(dur));
}
// CSS positions the title and timeline together, leaving room for the sidebar.
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
  drawVodBar(cur, dur, seekAccum.baseTime);
}
function showVodBar() {
  if (!state.vod) return;                // seek bar is for past videos only, never live
  document.getElementById('vodbar').className = '';   // un-hide first
  // A rewound live stream ends at the live edge: its right-hand slot is Go live.
  var rewound = !!state.vod.liveRewind;
  document.getElementById('vodbar-dur').className = rewound ? 'hidden' : '';
  var golive = document.getElementById('vodgolive');
  if (!rewound) golive.className = 'hidden';
  else if (golive.className === 'hidden') golive.className = '';
  applyVodCtrlFocus();                       // then re-apply focus, never blindly cleared
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
  vodPointerHover = '';
  vodDragging = false;
  vodButtonNav = false;
  vodFocus = '';                         // focus must never outlive the controls
  document.getElementById('vodbar').className = 'hidden';
  document.getElementById('vod-scrim').className = 'hidden';
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
  qualityAlertReset();          // the switch it just asked for takes a moment to land
  updateQualityButton();
}

/* Player options that ride on top of hls.js */
// Low latency trims how far behind the live edge we play. It only takes hold on
// a fresh hls instance, so toggling it reloads the current stream.
/* hls.js options that guard against how this TV's video pipeline fails, shared by
   live and past-video playback. nudgeOnVideoHole and liveSyncOnStallIncrease are
   already on by default in hls.js 1.7. */
var HLS_TV_GUARDS = {
  // An MSE append that never completes (the TV's decoder wedged) is reported as an
  // error after 10s instead of hanging for ever; normal appends take well under 1s.
  appendTimeout: 10000,
  // A picked fixed quality survives a load error instead of falling back to Auto.
  preserveManualLevelOnError: true
};
function withTvGuards(cfg) {
  for (var k in HLS_TV_GUARDS) if (!(k in cfg)) cfg[k] = HLS_TV_GUARDS[k];
  return cfg;
}
function hlsConfig() {
  var cfg = {
    enableWorker: true, capLevelToPlayerSize: true,
    lowLatencyMode: !!settings.lowlatency,
    // Nothing rewinds a live stream in this app, so 90s behind the playhead was
    // pure retention — at a 1080p60 bitrate that is tens of megabytes on a TV that
    // does not have them to spare.
    backBufferLength: 30, liveBackBufferLength: 30,
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
  return withTvGuards(cfg);
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

/* Live seek bar and Go live.
   The timeline runs from when the stream started (left) to the live edge (right).
   A live HLS playlist only holds the last few segments, so a rewind almost never
   fits in the live buffer. Kick keeps a recording of the stream that is still
   running (the is_live entry in the channel's videos list), and every segment of
   it carries a PROGRAM-DATE-TIME, so a moment on the timeline maps exactly onto a
   position in that recording. A short step back that the buffer does hold is a
   plain seek instead. Go live leaves the recording, or jumps a paused / lagging
   live picture back to the edge. */
var LIVE_EDGE_SLACK_SEC = 12;         // this close to the edge counts as live
var liveBar = { focused: false, timer: null, dragTarget: null, hover: false };   // dragTarget: seconds, while the pointer drags
var liveSeek = { delta: 0, timer: null, base: null, key: 0, started: 0, last: 0 };
function liveStreamStartMs() {
  var c = state.current && state.channels[state.current];
  return c && c.live ? parseKickTime(c.startedAt) : 0;
}
// How far the picture has fallen behind where live playback normally sits. hls.js
// deliberately plays a few segments back from the newest (on Kick that is ~20s),
// so "live" is its sync position, not the raw edge of the playlist.
function liveBehindSec(latency) {
  var video = document.getElementById('video'), sync = NaN;
  try { if (state.hls) sync = state.hls.liveSyncPosition; } catch (e) {}
  if (typeof sync === 'number' && isFinite(sync) && sync > 0) return Math.max(0, sync - (video.currentTime || 0));
  return latency;
}
// Positions in seconds from the stream's start: `edge` is where live playback
// sits (the right end of the timeline) and `cur` is the frame on screen.
function livePositions() {
  var startMs = liveStreamStartMs();
  if (!startMs || state.vod) return null;
  // Before the first frame, currentTime is 0 while the playlist already spans the
  // live window, which reads as minutes behind and flashed Go live at startup.
  // Until the picture is really playing, it counts as at the edge.
  var video = document.getElementById('video');
  if (!video || !(video.currentTime > 0) || video.readyState < 2) {
    var running = Math.max(1, (Date.now() - startMs) / 1000);
    return { startMs: startMs, edge: running, cur: running, behind: 0 };
  }
  var latency = liveLatencySec();
  var lag = Math.max(0, latency - liveBehindSec(latency));   // what live normally trails by
  var edge = Math.max(1, (Date.now() - startMs) / 1000 - lag);
  var cur = Math.max(0, Math.min(edge, (Date.now() - startMs) / 1000 - latency));
  return { startMs: startMs, edge: edge, cur: cur, behind: edge - cur };
}
function liveBarVisible() {
  var el = document.getElementById('livebar');
  return !!el && el.className.indexOf('hidden') === -1;
}
function showLiveBar(focus) {
  var el = document.getElementById('livebar');
  if (!el || !livePositions()) { hideLiveBar(); return; }
  if (focus) liveBar.focused = true;
  el.className = (liveBar.focused ? 'focused' : '') + (state.sidebarOpen ? ' withside' : '');
  drawLiveBar();
  if (!liveBar.timer) liveBar.timer = setInterval(drawLiveBar, 1000);
  placeDiagnostics();
}
function hideLiveBar() {
  resetLiveSeek();
  liveBar.focused = false;
  liveBar.dragTarget = null;
  liveBar.hover = false;
  var el = document.getElementById('livebar');
  if (el && el.className.indexOf('hidden') === -1) { el.className = 'hidden'; placeDiagnostics(); }
  if (liveBar.timer) { clearInterval(liveBar.timer); liveBar.timer = null; }
}
function drawLiveBar() {
  var p = livePositions();
  if (!p) { hideLiveBar(); return; }
  var W = 1500, mid = 20;
  var dragging = liveBar.dragTarget !== null;
  var pending = dragging || liveSeek.base !== null;
  var cur = dragging ? liveBar.dragTarget :
    (pending ? Math.max(0, Math.min(p.edge, liveSeek.base + liveSeek.delta)) : p.cur);
  var px = Math.max(0, Math.min(1, cur / p.edge)) * W;
  var hw = liveBar.focused ? 14 : 8, hh = liveBar.focused ? 38 : 30, hy = liveBar.focused ? 1 : 5;
  changedAttr(document.getElementById('livebar-played'), 'd', 'M0,' + mid + ' L' + px.toFixed(1) + ',' + mid);
  var handle = document.getElementById('livebar-handle');
  changedAttr(handle, 'width', hw); changedAttr(handle, 'height', hh); changedAttr(handle, 'y', hy);
  changedAttr(handle, 'x', (px - hw / 2).toFixed(1));
  var origin = document.getElementById('livebar-origin');
  changedAttr(origin, 'visibility', pending ? 'visible' : 'hidden');
  if (pending) {
    var ox = (Math.max(0, Math.min(1, p.cur / p.edge)) * W).toFixed(1);
    changedAttr(origin, 'x1', ox); changedAttr(origin, 'x2', ox);
  }
  changedText(document.getElementById('livebar-cur'), fmtClock(cur));
  // The right-hand slot: the stream's running time while live, Go live (same
  // width, so the track never resizes) once the picture is behind.
  var behind = (pending ? p.edge - cur : p.behind) > LIVE_EDGE_SLACK_SEC;
  var chip = document.getElementById('livebar-live'), end = document.getElementById('livebar-end');
  var chipClass = behind ? '' : 'hidden', endClass = behind ? 'hidden' : '';
  if (chip.className !== chipClass) chip.className = chipClass;
  if (end.className !== endClass) end.className = endClass;
  changedText(end, fmtClock(p.edge));
}
// Keep the info bar (and the timeline with it) up while the viewer is seeking.
function revealLiveBar() {
  var c = state.current && state.channels[state.current];
  if (c) showOverlay(c);
  showLiveBar(true);
}
function liveSeekKey(key, repeat) {
  var now = Date.now();
  if (!repeat || liveSeek.key !== key) { liveSeek.key = key; liveSeek.started = now; }
  else if (now - liveSeek.last < 150) return;
  liveSeek.last = now;
  var held = now - liveSeek.started;
  var step = held >= 3000 ? 300 : (held >= 1000 ? 120 : 30);   // a live stream is hours long
  liveSeekBy(key === KEY.LEFT ? -step : step);
}
function liveSeekBy(delta) {
  var p = livePositions();
  if (!p) return;
  if (liveSeek.base === null) liveSeek.base = p.cur;
  // Clamp the running total too, so pressing Right at the edge does not bank
  // seconds that a later Left then has to cancel out first.
  var target = Math.max(0, Math.min(p.edge, liveSeek.base + liveSeek.delta + delta));
  liveSeek.delta = target - liveSeek.base;
  var pop = document.getElementById('seekpop');
  var amount = document.createElement('span');
  amount.className = 'seekvalue';
  var d = Math.round(liveSeek.delta);
  amount.textContent = (d >= 0 ? '+' : '-') + fmtClock(Math.abs(d));
  pop.textContent = '';
  pop.appendChild(amount);
  var dest = document.createElement('span');
  dest.className = 'seekdestination';
  dest.textContent = p.edge - target <= LIVE_EDGE_SLACK_SEC ? 'Back to live' : 'Jump to ' + fmtClock(target);
  pop.appendChild(dest);
  pop.style.setProperty('--seek-wait', SEEK_APPLY_MS + 'ms');
  pop.className = '';
  clearTimeout(liveSeek.timer);
  liveSeek.timer = setTimeout(applyLiveSeek, SEEK_APPLY_MS);
  revealLiveBar();
}
function resetLiveSeek() {
  clearTimeout(liveSeek.timer);
  var had = liveSeek.base !== null;
  liveSeek.timer = null; liveSeek.base = null; liveSeek.delta = 0; liveSeek.key = 0;
  if (had && !state.vod) {
    var pop = document.getElementById('seekpop');
    if (pop) pop.className = 'hidden';
  }
}
function applyLiveSeek() {
  var base = liveSeek.base, delta = liveSeek.delta;
  resetLiveSeek();
  document.getElementById('seekpop').className = 'hidden';
  if (base === null || !delta) { drawLiveBar(); return; }
  var p = livePositions();
  if (!p) return;
  seekLiveTo(Math.max(0, Math.min(p.edge, base + delta)));
}
// Put the picture at `target` seconds into the stream.
function seekLiveTo(target) {
  var p = livePositions();
  if (!p || !state.current) return;
  if (p.edge - target <= LIVE_EDGE_SLACK_SEC) { goLive(); return; }
  var video = document.getElementById('video');
  var range = liveSeekRange(video);
  var t = (video.currentTime || 0) + (target - p.cur);
  if (range && t >= range.start + 1 && t <= range.end - 1) {
    PB.userSeekUntil = Date.now() + 8000;      // a deliberate seek, not a freeze
    try { video.currentTime = t; } catch (e) {}
    playVideo(video);
    drawLiveBar();
    return;
  }
  openLiveRecording(state.current, p.startMs + target * 1000);
}
// Back to the live edge: out of a rewound recording, or forward to the edge of
// a live picture that was paused or has drifted behind.
function goLive() {
  resetLiveSeek();
  liveRecordingSession++;        // a recording lookup still in flight must not land after this
  if (liveRecordingPending) { liveRecordingPending = false; setBanner(''); }
  if (state.vod && state.vod.liveRewind) { exitVod(); return; }   // exitVod plays vodReturn
  if (!state.current) return;
  var video = document.getElementById('video');
  var range = liveSeekRange(video);
  PB.userSeekUntil = Date.now() + 8000;
  if (range) { try { video.currentTime = liveTarget(video, range); } catch (e) {} }
  playVideo(video);
  if (liveBarVisible()) drawLiveBar();
}
var liveRecordingSession = 0, liveRecordingPending = false;
function openLiveRecording(slug, wallMs) {
  var c = state.channels[slug];
  if (!c || !c.live) return;
  var ses = ++liveRecordingSession, session = PB.session;
  liveRecordingPending = true;
  setBanner('Switching to VOD...');
  serviceGet('/api/v2/channels/' + encodeURIComponent(slug) + '/videos', function (err, data) {
    if (ses !== liveRecordingSession) return;
    liveRecordingPending = false;
    if (state.current !== slug || state.vod || session !== PB.session) return;
    setBanner('');
    var list = Array.isArray(data) ? data : ((data && data.data) || []);
    var rec = null, anyLive = null;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || !v.is_live || !playableVod(v)) continue;
      if (!anyLive) anyLive = v;
      if (v.created_at === c.startedAt) { rec = v; break; }   // created_at is the stream start
    }
    rec = rec || anyLive;
    if (!rec) { toast(err ? 'Could not reach Kick' : 'Rewind is not available for this stream'); return; }
    // created_at gets us close; the playlist's own timestamps correct it once it loads.
    var recStart = parseKickTime(rec.created_at) || parseKickTime(c.startedAt);
    state.vodReturn = slug;
    playVod(rec, [rec], 0, slug, {
      liveRewind: true,
      resumeAt: Math.max(0, (wallMs - recStart) / 1000),
      wallTarget: wallMs,
      recStartMs: recStart
    });
  }, { priority: 0 });
}
// A rewound recording is a snapshot of the stream as it was when loaded. Reaching
// its end either means there is more by now (load it again and carry on) or that
// we have caught up with live.
function liveRewindEnded() {
  var v = state.vod;
  if (!v || !v.liveRewind) return;
  var video = document.getElementById('video');
  var dur = video.duration || 0;
  var endMs = v.recEndMs || (v.recStartMs ? v.recStartMs + dur * 1000 : 0);
  // Reload only while it keeps growing; a copy that came back no longer than the
  // last one means the stream is over or we are at the edge.
  var grew = v.endReloadDur == null || dur - v.endReloadDur > 5;
  if (grew && endMs && Date.now() - endMs > 60000) {
    v.endReloadDur = dur;
    v.resumeAt = Math.max(0, (video.currentTime || 0) - 1);
    v.wallTarget = 0;
    attachVod(v.source);
    return;
  }
  goLive();
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
  var liveControls = !state.vod && liveBarVisible();
  var chatBox = document.getElementById('chat');
  var chatOnLeft = ChatWindow.side() === 'left' && chatBox.classList.contains('on');
  el.style.left = chatOnLeft ? 'auto' : (state.sidebarOpen ? '500px' : '30px');
  el.style.right = chatOnLeft ? '30px' : 'auto';
  el.style.bottom = vodControls ? '380px' : (state.sidebarOpen ? (liveControls ? '230px' : '150px') : (liveControls ? '160px' : '30px'));   // above the VOD title and timeline
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
      pill.textContent = it.kind === 'blockedcats' ? String(getBlockedCats().length) : settingsRangeLabel(it);
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
      !ownerOpen || updateopen) {
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
  var settingsPopups = ['settingsbox', 'dimoptbox', 'chatoptbox', 'blockedcatsbox'];
  var upperPopups = ['confirmbox', 'addbox', 'updatebox', 'qualityoptbox', 'toast'];
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

/* Buffering spinner (live and VOD) and VOD play/pause button */
var spinnerOn = false;
// A rebuffer that resolves in a couple of hundred milliseconds is invisible if we
// keep quiet, and reads as a glitch if we flash a spinner at it. Wait a beat first:
// short stalls never show anything, long ones still spin up promptly.
var SPINNER_GRACE_MS = 300;
var spinnerWaitTimer = null;
function showSpinnerSoon() {
  if (spinnerOn || spinnerWaitTimer) return;
  spinnerWaitTimer = setTimeout(function () {
    spinnerWaitTimer = null;
    showSpinner();
  }, SPINNER_GRACE_MS);
}
function cancelSpinnerSoon() {
  if (spinnerWaitTimer) { clearTimeout(spinnerWaitTimer); spinnerWaitTimer = null; }
}
function showSpinner() {
  if (spinnerOn) return;
  if (document.getElementById('pbstatus').className.indexOf('hidden') === -1) return;  // reconnecting banner already up
  spinnerOn = true;
  document.getElementById('spinner').className = '';
  hideVodPlay();
}
function hideSpinner() {
  cancelSpinnerSoon();   // before the guard below: a spinner that is only pending still has to be called off
  if (!spinnerOn) return;
  spinnerOn = false;
  document.getElementById('spinner').className = 'hidden';
  if (state.vod && document.getElementById('overlay').className.indexOf('hidden') === -1) showVodPlay();
}
// Two stacked glyphs cross-fade rather than one path changing its d: Chromium 87
// cannot tween path data, and this swap is the whole acknowledgement for the press,
// so it has to read as movement. An SVG element's className is read-only here —
// setAttribute is the only way to class it.
function vodPlayIcon() {
  var paused = document.getElementById('video').paused;
  document.getElementById('vodplay-play').setAttribute('class', 'vpglyph' + (paused ? ' on' : ''));
  document.getElementById('vodplay-pause').setAttribute('class', 'vpglyph' + (paused ? '' : ' on'));
}
function showVodPlay() {
  if (!state.vod || spinnerOn) return;
  vodPlayIcon();
  document.getElementById('vodplay').className = '';   // un-hide first...
  document.getElementById('vodback').className = '';
  document.getElementById('vodfwd').className = '';
  applyVodCtrlFocus();                                     // ...then restore any focus ring
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
var CHAT_MAX = 160;                       // bounded scrollback, including off-screen messages
var CHAT_DELAY_MAX = 1000;
var chatPending = [], chatDelayTimer = null;
var chat = { ws: null, room: null, want: false, retry: 0, retryTimer: null,
             activityMs: 120000, activityTimer: null, pongTimer: null };
/* How long to hold a message. Auto (-1) holds it as long as the picture trails
   real time: every segment carries the wall-clock time it was broadcast, so
   now minus the playing frame's time is exactly how far behind the video is.
   Until the first frame plays that is unknown, and messages wait. */
var CHAT_DELAY_UNKNOWN_MS = 60000;
function chatDelayMs() {
  if (settings.chatDelay >= 0) return settings.chatDelay * 1000;
  if (state.vod) return 0;
  var video = document.getElementById('video'), date = null;
  try { date = state.hls && state.hls.playingDate; } catch (e) {}
  if (!video || !(video.currentTime > 0)) return CHAT_DELAY_UNKNOWN_MS;
  var lag = date && date.getTime ? Date.now() - date.getTime() : liveLatencySec() * 1000;
  return isFinite(lag) ? Math.max(0, Math.min(CHAT_DELAY_UNKNOWN_MS, lag)) : 0;
}
// One timer for the ordered delay queue. Channel changes and closing chat discard
// pending messages, so nothing from the previous room can appear after switching.
// On Auto the lag moves (buffering, a pause, Go live), so the wait is re-judged
// at least every second.
function scheduleChatDelay() {
  if (chatDelayTimer !== null || !chatPending.length) return;
  var wait = Math.max(0, chatPending[0].at + chatDelayMs() - Date.now());
  if (settings.chatDelay < 0) wait = Math.min(wait, 1000);
  chatDelayTimer = setTimeout(drainChatDelay, wait);
}
function drainChatDelay() {
  if (chatDelayTimer !== null) clearTimeout(chatDelayTimer);
  chatDelayTimer = null;
  var now = Date.now(), count = 0, delay = chatDelayMs();
  while (chatPending.length && chatPending[0].at + delay <= now && count < 40) {
    var item = chatPending.shift(); count++;
    if (chat.want && settings.chat && chat.room === item.room && currentRoomId() === item.room)
      addChatMessage(item.data, item.at);
  }
  scheduleChatDelay();
}
function rescheduleChatDelay() {
  if (chatDelayTimer !== null) clearTimeout(chatDelayTimer);
  chatDelayTimer = null;
  scheduleChatDelay();
}
function queueChatMessage(data) {
  if (!data || !data.sender || !chat.want || !settings.chat) return;
  chatPending.push({ data: data, at: Date.now(), room: chat.room });
  if (chatPending.length > CHAT_DELAY_MAX) chatPending.shift();
  if (settings.chatDelay === 0 && chatPending.length === 1 && chatDelayTimer === null) drainChatDelay();
  else scheduleChatDelay();
}
function clearChatDelay() {
  if (chatDelayTimer !== null) clearTimeout(chatDelayTimer);
  chatDelayTimer = null; chatPending = [];
}
function chatEl() { return document.getElementById('chat'); }
function chatMessagesEl() { return document.getElementById('chat-messages'); }
// Window geometry is independent from message style and survives reconnects.
function chatLightBackground() { return settings.chatBackground === 'white' && settings.chatTransparency <= 50; }
function chatClassBase() {
  var cls = ['csize-' + settings.chatSize,
             'copacity-' + settings.chatOpacity, 'cbg-' + settings.chatBackground];
  if (chatLightBackground()) cls.push('ctheme-light');
  return cls.join(' ');
}
function showChatOverlay() { chatEl().classList.add('on'); applyChatStyle(); }
function hideChatOverlay() { chatEl().className = chatClassBase(); ChatWindow.hide(); }
function applyChatStyle() {
  var el = chatEl();
  var on = el.classList.contains('on'), wasLight = el.classList.contains('ctheme-light');
  el.className = chatClassBase() + (on ? ' on' : '');
  var rgb = settings.chatBackground === 'white' ? '255,255,255' : '0,0,0';
  el.style.backgroundColor = 'rgba(' + rgb + ',' + (100 - settings.chatTransparency) / 100 + ')';
  ChatWindow.show();
  if (wasLight !== chatLightBackground()) {
    var names = chatMessagesEl().querySelectorAll('.cuser');
    for (var i = 0; i < names.length; i++) names[i].style.color = chatNameColor(names[i].getAttribute('data-color'), chatLightBackground());
  }
}
function clearChat() {
  chatRenderQueue = [];
  if (chatRenderFrame !== null) { cancelAnimationFrame(chatRenderFrame); chatRenderFrame = null; }
  if (window.UIImages) UIImages.release(chatMessagesEl());
  chatMessagesEl().innerHTML = ''; ChatWindow.clear();
}
// Chat only exists on a live stream with a chat room; say why when it cannot.
function chatCanTurnOn() {
  if (!state.current || state.vod) { toast('Chat is available on live streams'); return false; }
  if (!currentRoomId()) { toast('Chat is unavailable for this channel'); return false; }
  return true;
}
function toggleChat() {
  applyStreamerChatPreferences();
  if (chatEl().classList.contains('on')) settings.chat = false;
  else {
    if (!chatCanTurnOn()) return;
    settings.chat = true;
  }
  saveSettings();
  syncChat();
  if (state.sidebarOpen) resetIdle();
}
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
  applyStreamerChatPreferences();
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
  ChatWindow.status('connecting', 'Connecting...');
  openChatSocket(room);
}
// A socket can die without ever closing (router restart, WAN failover): nothing
// arrives and onclose never fires. So we watch for silence ourselves. After the
// server's activity_timeout with no traffic we ping; no answer within 30s means
// the link is dead and we reconnect.
function stopChatHeartbeat() {
  clearTimeout(chat.activityTimer); chat.activityTimer = null;
  clearTimeout(chat.pongTimer); chat.pongTimer = null;
}
function armChatHeartbeat(ws, room) {
  stopChatHeartbeat();
  chat.activityTimer = setTimeout(function () {
    chat.activityTimer = null;
    if (chat.ws !== ws) return;
    try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch (e) {}
    chat.pongTimer = setTimeout(function () {
      chat.pongTimer = null;
      if (chat.ws !== ws) return;
      ws.onclose = null;                       // a dead socket may take minutes to report closing
      try { ws.close(); } catch (e) {}
      chatSocketClosed(ws, room);
    }, 30000);
  }, chat.activityMs);
}
function chatSocketClosed(ws, room) {
  if (chat.ws !== ws) return;
  chat.ws = null;
  stopChatHeartbeat();
  scheduleChatRetry(room);
}
function scheduleChatRetry(room) {
  if (!(chat.want && settings.chat && currentRoomId() === room)) return;
  ChatWindow.status('reconnecting', 'Reconnecting...');
  chat.retry++;
  var delay = Math.min(15000, 1500 * chat.retry);
  clearTimeout(chat.retryTimer);
  chat.retryTimer = setTimeout(function () {
    chat.retryTimer = null;
    if (chat.want && settings.chat && currentRoomId() === room) openChatSocket(room);
  }, delay);
}
function openChatSocket(room) {
  var ws;
  try { ws = new WebSocket(CHAT_URL); }
  catch (e) { ChatWindow.status('unavailable', 'Chat connection unavailable'); scheduleChatRetry(room); return; }
  chat.ws = ws;
  armChatHeartbeat(ws, room);
  ws.onmessage = function (ev) {
    if (chat.ws !== ws || !chat.want || chat.room !== room) return;
    armChatHeartbeat(ws, room);                 // any traffic proves the link is alive
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.event === 'pusher:ping') { try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch (e) {} return; }
    if (m.event === 'pusher:pong') return;
    if (m.event === 'pusher:connection_established') {
      chat.retry = 0;               // connected for real: future drops start from a short delay again
      var info = null; try { info = JSON.parse(m.data); } catch (e) {}
      var secs = info && +info.activity_timeout;
      if (secs > 0) { chat.activityMs = Math.min(300, Math.max(30, secs)) * 1000; armChatHeartbeat(ws, room); }
      try { ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'chatrooms.' + room + '.v2' } })); } catch (e) {}
      return;
    }
    if (m.event === 'pusher_internal:subscription_succeeded') { ChatWindow.status('connected', 'Live'); return; }
    if (m.event && m.event.indexOf('ChatMessageEvent') !== -1) {
      var d; try { d = JSON.parse(m.data); } catch (e) { return; }
      ChatWindow.status('connected', 'Live');
      queueChatMessage(d);
    }
  };
  ws.onclose = function () { chatSocketClosed(ws, room); };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}
function disconnectChat() {
  chat.want = false; chat.room = null;
  clearChatDelay();
  if (chat.retryTimer) { clearTimeout(chat.retryTimer); chat.retryTimer = null; }
  stopChatHeartbeat();
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
      img.decoding = 'async';   // keep an unseen emote's decode off the paint that shows the message
      img.setAttribute('data-ui-src', 'https://files.kick.com/emotes/' + m[1] + '/fullsize');
      img.setAttribute('data-ui-emote', '1');
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
// Kick hands out some very dark identity colours — deep blue, maroon — and chat sits
// over the black player plane, where those names are unreadable from a sofa. Lift
// anything below a usable luminance, keeping which colour it is.
var CHAT_NAME_MIN_LUM = 0.4;
function chatNameColor(hex, lightBackground) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return lightBackground ? '#247500' : '#53fc18';
  var n = parseInt(m[1], 16);
  var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lightBackground) {
    var scale = lum > 0.42 ? 0.42 / lum : 1;
    return 'rgb(' + Math.round(r * scale) + ',' + Math.round(g * scale) + ',' + Math.round(b * scale) + ')';
  }
  if (lum >= CHAT_NAME_MIN_LUM) return '#' + m[1];
  // Blend towards white by exactly the amount that reaches the floor: blending adds
  // (1 - lum) * t of luminance, so t falls straight out. Multiplying the channels
  // instead cannot get a saturated blue there — blue carries 7% of luminance, so it
  // clamps at 255 and stays dark.
  var t = (CHAT_NAME_MIN_LUM - lum) / (1 - lum);
  r = Math.round(r + (255 - r) * t);
  g = Math.round(g + (255 - g) * t);
  b = Math.round(b + (255 - b) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
var chatRenderQueue = [], chatRenderFrame = null;
function chatCovered() { return document.hidden || browse.open || cats.open || vods.open; }
function addChatMessage(d, receivedAt) {
  if (!d || !d.sender) return;
  if (settings.chatBots === 'hide' && isBotMessage(d)) return;
  chatRenderQueue.push({ data: d, at: receivedAt });
  while (chatRenderQueue.length > CHAT_MAX) chatRenderQueue.shift();
  flushChatRender();
}
function flushChatRender() {
  if (chatCovered() || chatRenderFrame !== null || !chatRenderQueue.length) return;
  chatRenderFrame = requestAnimationFrame(function () {
    chatRenderFrame = null;
    if (chatCovered()) return;
    var box = chatMessagesEl(), fragment = document.createDocumentFragment();
    var batch = chatRenderQueue.splice(0, 40);
    batch.forEach(function (entry) { fragment.appendChild(buildChatMessage(entry.data, entry.at)); });
    var emotes = fragment.querySelectorAll('img[data-ui-src]');   // only the new rows need watching
    box.appendChild(fragment);
    while (box.children.length > CHAT_MAX) {
      if (window.UIImages) UIImages.release(box.firstChild);
      box.removeChild(box.firstChild);
    }
    ChatWindow.messageAdded(batch.length);
    if (window.UIImages && emotes.length) UIImages.watchNodes(emotes);
    if (chatRenderQueue.length) flushChatRender();
  });
}
function buildChatMessage(d, receivedAt) {
  var row = document.createElement('div');
  row.className = 'cmsg';
  if (settings.chatTimestamps) {
    var ts = document.createElement('span'); ts.className = 'ctime';
    var dt = new Date(receivedAt || Date.now());
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
  u.setAttribute('data-color', color || '');
  u.style.color = chatNameColor(color, chatLightBackground());
  u.textContent = d.sender.username || '';
  row.appendChild(u);
  // ': ' rather than a bare space — without it the coloured name and the white message
  // run together into one blob at sofa distance. Kick's own chat does the same.
  row.appendChild(document.createTextNode(': '));
  appendChatContent(row, d.content);
  return row;
}
/* OLED burn-in guard.
   Static bright pixels can burn into an OLED over time. When nothing has moved
   for a while and the screen is showing something static (an idle message or a
   paused frame), we heavily dim the whole panel so nothing stays lit and bright.
   Any remote or pointer activity wakes it back up. */
var saver = { on: false, timer: null, staticSince: 0 };
function markInput() {
  state.lastInput = Date.now();
  if (saver.on) wakeSaver();
  touchSettings();
}
function isStaticScreen() {
  var v = document.getElementById('video');
  // A full-screen panel is static chrome — its green frame, header chips and card edges do
  // not move whatever plays behind it, and that frame is the largest bright constant in the
  // app. Opening Browse used to pause playback, so a paused video stood in for "nothing is
  // changing"; it no longer does, which left the guard unable to fire over an open panel.
  // The surf list only counts when it is the persistent stream-end one; normally it
  // auto-hides in seconds.
  if (browse.open || cats.open || vods.open || (chpop.open && chpop.persistent)) return true;
  // a VOD is moving video too, so only an idle screen or a paused frame counts
  return (!state.current && !state.vod) || (v && v.paused);
}
/* Runs once a second, not on a lazy beat. staticSince is stamped on the first tick that
   sees a still screen, so the tick period lands on top of the setting twice over — once
   waiting to notice, once waiting to fire. At 20s that made a 1-minute guard arrive at
   about 80. The body is a handful of flag reads, so a 1s beat is free; keep it there. */
function checkSaver() {
  if (!state.ready || !settings.saverMin) return;   // 0 = guard off
  // A screen that starts moving again ends the guard by itself, without waiting for a
  // keypress. Auto-advance is the case this exists for: a stream ends while you are
  // away, the guard fires during the gap where the video is paused, and the next
  // channel then plays on behind a dim overlay nobody is there to dismiss.
  if (!isStaticScreen()) {
    saver.staticSince = 0;
    if (saver.on) wakeSaver();
    return;
  }
  if (saver.on) return;
  var now = Date.now();
  if (!saver.staticSince) saver.staticSince = now;
  if (state.notifyCurrent) return;
  // Both clocks have to run out: no input, and the screen actually still for that long.
  // So a short pause between two streams cannot trip the guard on its way past.
  var idle = settings.saverMin * 60000;
  if (now - state.lastInput >= idle && now - saver.staticSince >= idle) showSaver();
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
    positionStreamPreview(e, row, document.getElementById('chpop-panel'));
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
  var rebuild = true;
  if (!chpop.open) {
    chpop.open = true;
    showCursor();
    document.getElementById('chpop').className = '';
    chpop.list = live;
    var ci = state.current ? live.indexOf(state.current) : -1;
    chpop.idx = ci >= 0 ? ci : 0;
    prefetchSidePreviews();               // warm thumbnails for the surf list too
  } else {
    // The rows on screen belong to the previous list. Rebuild only when the live set
    // really changed; surfing through an unchanged list just moves the highlight.
    rebuild = chpop.list.join() !== live.join();
    chpop.list = live;
    if (chpop.idx >= live.length) chpop.idx = live.length - 1;
  }
  var n = chpop.idx + dir;
  if (n < 0) n = live.length - 1;
  else if (n >= live.length) n = 0;
  chpop.idx = n;
  if (rebuild) renderChpop(); else applyChpopFocus();
  resetChpopTimer();
}
var chpopFocusEl = null;
// data-base carries the blocked-category dimming
function chpopRowBaseOf(row) { return row.getAttribute('data-base') || 'chrow'; }
// Surfing channels is rapid-fire input, and rebuilding the list per press re-assigns
// every avatar background — which a TV can visibly re-raster. Move the highlight only.
function applyChpopFocus() {
  var box = document.getElementById('chpop-list');
  var el = box.children[chpop.idx] || null;
  chpopFocusEl = swapFocus(box, chpopFocusEl, el, chpopRowBaseOf, true);
  scrollIntoViewport(box, el, 6);
  chpopPreviewCard.update();
}
function renderChpop() {
  var box = document.getElementById('chpop-list');
  box.innerHTML = '';
  chpop.list.forEach(function (slug, i) {
    var c = state.channels[slug] || {};
    var row = document.createElement('div');
    var base = 'chrow' + (isChannelBlocked(c) ? ' blocked' : '');
    row.className = base;
    row.setAttribute('data-base', base);
    row.setAttribute('data-idx', i);
    var av = document.createElement('div');
    av.className = 'chav';
    if (c.avatar) av.style.backgroundImage = 'url(' + c.avatar + ')';
    else av.textContent = (c.name || slug).charAt(0).toUpperCase();
    row.appendChild(av);
    var mid = document.createElement('div');
    mid.className = 'chmid';
    mid.innerHTML = '<div class="chname"></div><div class="chgame"><span class="chcat"></span><span class="chtitle"></span></div>';
    mid.children[0].textContent = c.name || slug;
    mid.children[1].children[0].textContent = c.category || 'Live';
    mid.children[1].children[1].textContent = c.title ? ' · ' + c.title : '';
    row.appendChild(mid);
    var vw = document.createElement('span');
    vw.className = 'chview';
    vw.innerHTML = '<span class="chdot"></span>';
    vw.appendChild(document.createTextNode(fmtViewers(c.viewers || 0)));
    row.appendChild(vw);
    box.appendChild(row);
  });
  clipChpopText(box);
  applyChpopFocus();
}
// Same hand-made ".." as the sidebar (the TV draws the browser's ellipsis badly).
// All widths are read in one pass, then the text is written.
function clipChpopText(box) {
  var names = box.querySelectorAll('.chname'), games = box.querySelectorAll('.chgame');
  if (!names.length) return;
  var nameFont = fontOf(names[0]), catFont = fontOf(games[0].children[0]), restFont = fontOf(games[0].children[1]);
  var nameW = [], gameW = [], i;
  for (i = 0; i < names.length; i++) { nameW.push(names[i].clientWidth); gameW.push(games[i].clientWidth); }
  for (i = 0; i < names.length; i++) {
    if (nameW[i] > 0) names[i].textContent = clipWithDots(names[i].textContent, nameFont, nameW[i]);
    if (gameW[i] > 0) clipTwoParts(games[i].children[0], games[i].children[1],
      games[i].children[0].textContent, games[i].children[1].textContent, catFont, restFont, gameW[i]);
  }
}
function fontOf(el) {
  var cs = getComputedStyle(el);
  return cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
}
// A category and " · title" pair sharing one line: the category keeps its room
// first and the title gets whatever is left.
function clipTwoParts(catEl, restEl, cat, rest, catFont, restFont, w) {
  var catText = cat ? clipWithDots(cat, catFont, w) : '';
  var left = w - (catText ? measureTextWidth(catText, catFont) : 0);
  var restText = rest && catText === cat && left > 0 ? clipWithDots(rest, restFont, left) : '';
  if (restText === '..') restText = '';   // no room for any of the title
  if (catEl.textContent !== catText) catEl.textContent = catText;
  if (restEl.textContent !== restText) restEl.textContent = restText;
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
  if (state.vod && vodPointerHover) {
    vodPointerHover = '';     // remote input resumes timed hiding, even under a parked cursor
    if (vodBarVisible()) armVodOverlayHide();
    if (state.sidebarOpen) resetIdle();
  }
  // Anything but Back cancels a pending exit. That covers the stream -> list -> exit
  // ladder too: once you have started moving around the list, Back means "close the
  // list" again, so browsing it can never drop you out of the app by surprise.
  if (k !== KEY.BACK && k !== KEY.STOP) { state.quitArmed = false; state.backOpenedSidebar = false; }
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
      if (cats.zone === 'grid' && cats.gridIdx > 0 && displayedCats()[cats.gridIdx - 1]) {
        var pc = displayedCats()[cats.gridIdx - 1];
        toggleCatPin(pc.slug, pc.name || pc.slug);
      }
    }
    else if (k === KEY.RED) {                         // red blocks or unblocks the focused category
      if (cats.zone === 'grid' && cats.gridIdx > 0 && displayedCats()[cats.gridIdx - 1]) {
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
    // the dropdown swallows Back and Left first, so neither closes Browse under it
    if (browse.langMenuOpen && (k === KEY.BACK || k === KEY.LEFT || k === KEY.RIGHT)) closeBrowseLangMenu();
    else if (k === KEY.BLUE || k === KEY.BACK) closeBrowse();
    else if (k === KEY.YELLOW) openCats();               // yellow opens the categories picker
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
    else if (k === KEY.LEFT) settingsActivate(-1);
    return;
  }
  if (chpop.open) {
    e.preventDefault();
    // Colour keys and 0 close the list and then do their usual job below.
    if (k === KEY.RED || k === KEY.GREEN || k === KEY.YELLOW || k === KEY.BLUE || k === KEY.N0) closeChpop();
    else {
      if (isChUp(k) || k === KEY.UP) chpopMove(-1);
      else if (isChDown(k) || k === KEY.DOWN) chpopMove(1);
      else if (k === KEY.OK) chpopActivate();
      else if (k === KEY.BACK || k === KEY.LEFT || k === KEY.RIGHT) closeChpop();
      return;
    }
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
  if (k === KEY.GREEN) { if (!e.repeat) toggleChat(); return; }
  if (k === KEY.YELLOW) { openVodsForContext(); return; }
  if (!state.vod) {                                    // the surf list is for live channels
    if (isChUp(k)) { chpopMove(-1); return; }          // channel up/down surf the live list
    if (isChDown(k)) { chpopMove(1); return; }
  }
  // With the list open, OK belongs to the highlighted row, never to an alert.
  if (k === KEY.OK && state.notifyCurrent && !state.vod && !state.sidebarOpen) { activateNotify(); return; }
  // Rewind/fast-forward: a past video seeks; live rewinds along the stream's
  // timeline, and fast-forward heads back to the live edge.
  if (k === KEY.REW) { if (state.vod) seekVod(-60); else if (state.current) liveSeekBy(-60); return; }
  if (k === KEY.FF) {
    if (state.vod) seekVod(60);
    else if (state.current) { if (liveSeek.base !== null) liveSeekBy(60); else goLive(); }
    return;
  }
  // Transport keys mean the same thing whether or not the list is open.
  if (k === KEY.PAUSE) { try { video.pause(); } catch (e2) {} return; }
  if (k === KEY.PLAY) { playVideo(video); return; }
  if (k === KEY.STOP) { if (state.vod) exitVod(); else armOrExit(); return; }
  if (state.sidebarOpen) {
    resetIdle();
    // The bottom player tools are pointer-only: hovering highlights them, but
    // the D-pad always drives the channel list. Left/Right consistently tucks
    // the sidebar away, never cycles the tools.
    if (state.playerToolFocus >= 0) setPlayerToolFocus(-1);
    if (k === KEY.UP) moveSide(-1);
    else if (k === KEY.DOWN) moveSide(1);
    else if (k === KEY.OK) activateSide();               // OK (or a click) opens the highlighted channel
    else if (k === KEY.LEFT || k === KEY.RIGHT) closeSidebar();   // either side tucks the list away
    else if (k === KEY.BACK) {
      // Back is what put this list on screen, so Back again carries on up and out —
      // through the same "press again to exit" confirmation the exit uses everywhere
      // else, never straight out. Opened any other way (Left/Right, the pointer),
      // Back still just tucks the list away.
      if (state.backOpenedSidebar) armOrExit();
      else closeSidebarWithGrace();
    }
    return;
  }
  if (state.vod) {                                       // watching a past video
    if (k === KEY.BACK) {
      var dismissVodControls = vodBarVisible() || seekAccum.baseTime !== null;
      resetSeekAccum();
      vodButtonNav = false;
      if (dismissVodControls) {
        clearTimeout(overlayTimer);
        hideVodControls();
        state.suppressNudgeUntil = Date.now() + NUDGE_SUPPRESS_MS;
        hideCursor();
      } else {
        openSidebar();                                 // same ladder as live: the next Back arms the exit
        if (state.sidebarOpen) state.backOpenedSidebar = true;
      }
      return;
    }
    if (k === KEY.UP) {
      if (!vodButtonNav || vodFocus !== 'buttons') focusVodButtons();
      else showVodOverlay();
      vodButtonNav = true;
      return;
    }
    if (k === KEY.DOWN) { focusVodBar(); return; }
    if (vodButtonNav && vodFocus === 'buttons') {
      if (k === KEY.LEFT) { vodBtnMove(-1); return; }
      if (k === KEY.RIGHT) { vodBtnMove(1); return; }
      if (k === KEY.OK) { vodBtnActivate(); return; }
    }
    if (k === KEY.LEFT || k === KEY.RIGHT) { seekVodKey(k, e.repeat); return; }
    // OK lands on the play/pause button and takes the action in the same press —
    // one press pauses, the next resumes. The rest of the controls come up around
    // it, so the press after that can be a seek without hunting for the ladder.
    if (k === KEY.OK) { focusVodButtons(); toggleVodPlay(); return; }
    return;
  }
  // OK brought up the live timeline: Left/Right seek along it, Back puts it away.
  if (state.current && liveBar.focused && liveBarVisible()) {
    if (k === KEY.LEFT || k === KEY.RIGHT) { liveSeekKey(k, e.repeat); return; }
    if (k === KEY.BACK) {
      resetLiveSeek();
      document.getElementById('overlay').className = 'hidden';
      clearTimeout(overlayTimer);
      hideLiveBar();
      state.suppressNudgeUntil = Date.now() + NUDGE_SUPPRESS_MS;
      hideCursor();
      return;
    }
  }
  // While a live stream is playing, Back steps up to the channel list rather than
  // straight at the exit; the next Back leaves. On the idle screen there is nothing
  // to step up to, so Back still arms the exit there, and STOP always means stop.
  if (k === KEY.BACK && state.current) {
    openSidebar();
    if (state.sidebarOpen) state.backOpenedSidebar = true;
    return;
  }
  if (k === KEY.BACK) { armOrExit(); return; }
  if (k === KEY.LEFT || k === KEY.RIGHT) openSidebar();  // left or right brings the list up
  else if (k === KEY.UP) chpopMove(-1);                 // up/down surf the live channels
  else if (k === KEY.DOWN) chpopMove(1);
  else if (k === KEY.OK) { if (state.current) toggleOverlay(); else openSidebar(); }
});

document.addEventListener('keyup', function (e) {
  if (e.keyCode === vodSeekKey.key) vodSeekKey.key = 0;
  if (e.keyCode === liveSeek.key) liveSeek.key = 0;
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
  if (isNaN(i) || i < 0 || i >= getBrowseGrid().items.length) return null;
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
  // Live keeps its full sidebar reveal. VOD reveals playback controls first;
  // reaching the left edge opens the sidebar as well.
  var lastX = -1, lastY = -1;
  playerEl.addEventListener('mousemove', function (e) {
    if (ChatWindow.activePointer(e.target)) return;
    if (diagDrag) return;                 // dragging the diagnostics window, not browsing
    if (liveBar.dragTarget !== null) return;   // dragging the live timeline
    if (!state.ready || state.mode !== 'player') return;
    if (lastX >= 0 && Math.abs(e.clientX - lastX) < 6 && Math.abs(e.clientY - lastY) < 6) return;
    lastX = e.clientX; lastY = e.clientY;
    showCursor();      // a real move brings the pointer back
    if (!state.sidebarOpen && Date.now() < state.suppressNudgeUntil) return;   // click-to-hide grace
    if (state.vod) {
      if (anyPanelOpen() || saver.on) return;
      if (vodDragging) return;
      var target = e.target;
      vodPointerHover = '';
      while (target && target !== playerEl) {
        if (target.id === 'vodbar' || VOD_BTN_IDS.indexOf(target.id) !== -1) {
          vodPointerHover = target.id;
          break;
        }
        target = target.parentNode;
      }
      if (state.sidebarOpen || e.clientX <= 48) nudgeSidebar();
      requestVodOverlay();
    } else if (liveBarVisible() && !state.sidebarOpen && e.clientX > 48) {
      // The timeline is up: pointing keeps it up rather than sliding it aside for
      // the channel list (which would pull it out from under the pointer). The
      // left edge still opens the list, as in a past video.
      armLiveOverlayHide();
    } else nudgeSidebar();
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
    if (hit && hit.idx !== state.sideFocus) {
      state.sideFocus = hit.idx;
      armSidePreview();      // pointing at a row earns it too
      applySideFocus();
    }
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
  favList.addEventListener('scroll', function () { if (state.sidebarOpen) scheduleSidePreview(); });
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
  BROWSE_HEADERS.forEach(function (id, i) {
    var header = document.getElementById(id);
    if (header) header.addEventListener('mouseenter', function () { browse.zone = 'header'; browse.headerIdx = i; applyBrowseFocus(true); });
  });
  ['cats-search', 'cats-close'].forEach(function (id, i) { document.getElementById(id).addEventListener('mouseenter', function () { cats.zone = 'header'; cats.headerIdx = i; applyCatsFocus(true); }); });
  ['vods-filter', 'vods-close'].forEach(function (id, i) { document.getElementById(id).addEventListener('mouseenter', function () { vods.zone = 'header'; vods.headerIdx = i; applyVodFocus(true); }); });
  document.getElementById('browse-langbtn').addEventListener('click', function (e) {
    e.stopPropagation();
    browse.zone = 'lang';
    toggleBrowseLangMenu();
  });
  var langMenu = document.getElementById('browse-langmenu');
  langMenu.addEventListener('click', function (e) {
    e.stopPropagation();
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (el && el !== this) toggleBrowseLang(parseInt(el.getAttribute('data-idx'), 10));
  });
  langMenu.addEventListener('mouseover', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (el && el !== this) {
      var i = parseInt(el.getAttribute('data-idx'), 10);
      if (i !== browse.langIdx) { browse.langIdx = i; renderBrowseLangMenu(); }
    }
  });
  // Anywhere else in Browse dismisses the dropdown, the way a menu should.
  document.getElementById('browse').addEventListener('click', function () {
    if (browse.langMenuOpen) closeBrowseLangMenu();
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
    scheduleBrowseFill();
  });
  browseGrid.addEventListener('scroll', scheduleBrowseFill);
  document.getElementById('browse-close').addEventListener('click', function () { closeBrowse(); });
  var catsBtn = document.getElementById('browse-cats-btn');
  if (catsBtn) catsBtn.addEventListener('click', function (e) { e.stopPropagation(); openCats(); });
  document.getElementById('browse-discover').addEventListener('click', function (e) { e.stopPropagation(); toggleBrowseDiscover(); });
  document.getElementById('browse-hideblocked').addEventListener('click', function (e) { e.stopPropagation(); toggleBrowseHideBlocked(); });
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
    browse.zone = 'pins'; browse.pinIdx = Array.prototype.indexOf.call(this.children, el);
    if (cslug) toggleBrowseCat(cslug, el.getAttribute('data-cname') || '');
    else clearBrowseCats();
  });
  // Categories popup pointer
  var catsGrid = document.getElementById('cats-grid');
  function catCardIdx(e) {
    var el = e.target;
    while (el && el !== catsGrid && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === catsGrid) return -2;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) || i < 0 || i >= getCatsGrid().items.length ? -2 : i;
  }
  catsGrid.addEventListener('mouseover', function (e) {
    var i = catCardIdx(e);
    if (i >= 0 && (i !== cats.gridIdx || cats.zone !== 'grid')) { cats.zone = 'grid'; cats.gridIdx = i; applyCatsFocus(); }
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
    if (i >= 0) { cats.zone = 'grid'; cats.gridIdx = i; catsActivate(); }
  });
  catsGrid.addEventListener('wheel', function (e) {
    if (!cats.open) return;
    e.preventDefault();
    catsGrid.scrollTop += (e.deltaY > 0 ? 1 : -1) * 160;
    if (!cats.error && catsGrid.scrollTop + catsGrid.clientHeight >= catsGrid.scrollHeight - 400) loadCatsMore(false);
  });
  document.getElementById('cats-close').addEventListener('click', function () { closeCats(); });
  document.getElementById('cats-search').addEventListener('input', function () {
    if (!cats.open) return;
    var q = this.value.trim();
    cats.query = q; cats.searchError = false; cats.searching = !!q; cats.focusKey = null;
    clearTimeout(catsSearchTimer);
    if (!q) {                                  // cleared: back to the paginated list
      cats.results = null; cats.searching = false;
      cats.gridIdx = 0;
      renderCats();
      if (!cats.list.length && cats.hasMore && !cats.error) loadCatsMore(true);
      return;
    }
    cats.results = []; cats.gridIdx = 0; renderCats();
    catsSearchTimer = setTimeout(function () { runCatsSearch(q); }, 250);
  });
  // Past videos popup pointer
  var vodsGrid = document.getElementById('vods-grid');
  function vodCardIdx(e) {
    var el = e.target;
    while (el && el !== vodsGrid && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === vodsGrid) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= getVodGrid().items.length) ? -1 : i;
  }
  vodsGrid.addEventListener('mouseover', function (e) {
    var i = vodCardIdx(e);
    if (i >= 0 && (i !== vods.gridIdx || vods.zone !== 'grid')) { vods.zone = 'grid'; vods.gridIdx = i; applyVodFocus(); }
  });
  vodsGrid.addEventListener('click', function (e) {
    var i = vodCardIdx(e);
    if (i >= 0) { vods.zone = 'grid'; vods.gridIdx = i; vodActivate(); }
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
  var vodTrackRect = null, scrubFrame = null, scrubX = 0;
  function vodTrackFrac(e) {
    var r = vodTrackRect || vodTrack.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  }
  function vodPreview(e) {
    var v = document.getElementById('video');
    if (isFinite(v.duration) && v.duration) drawVodBar(vodTrackFrac(e) * v.duration, v.duration);
  }
  document.getElementById('vodbar').addEventListener('mousedown', function (e) {
    if (!state.vod) return;
    for (var t = e.target; t; t = t.parentNode) if (t.id === 'vodgolive') return;   // Go live is a button
    // The handle overhangs the track's ends, so accept a grab just beyond them.
    vodTrackRect = vodTrack.getBoundingClientRect();
    if (e.clientX < vodTrackRect.left - 30 || e.clientX > vodTrackRect.right + 30) { vodTrackRect = null; return; }
    vodDragging = true;
    clearTimeout(overlayTimer);                 // keep the bar visible while dragging
    clearTimeout(state.idleTimer);
    document.getElementById('vodbar').className = '';
    vodPreview(e);
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (vodDragging) {
      scrubX = e.clientX;
      if (scrubFrame === null) scrubFrame = requestAnimationFrame(function () {
        scrubFrame = null;
        if (vodDragging) vodPreview({ clientX: scrubX });
      });
    }
  });
  document.addEventListener('mouseup', function (e) {
    if (vodDragging) {
      vodDragging = false;
      seekVodFrac(vodTrackFrac(e));
      vodTrackRect = null;
      if (scrubFrame !== null) { cancelAnimationFrame(scrubFrame); scrubFrame = null; }
      if (state.sidebarOpen) resetIdle();
    }
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
  bindSettingsListPointer(slist, function (e) {
    var i = sRowIdx(e);
    if (i >= 0 && i !== settings.focus) { settings.focus = i; applySettingsFocus(); }
  });
  slist.addEventListener('click', function (e) {
    if (e.target.tagName === 'INPUT') return;
    var i = sRowIdx(e);
    if (i < 0) return;
    settings.focus = i; applySettingsFocus();
    var node = e.target, onSwitch = false;
    while (node && node !== this) {
      if (node.getAttribute && node.getAttribute('data-setting-switch')) { onSwitch = true; break; }
      node = node.parentNode;
    }
    if (onSwitch) settingsActivate();
    else settingsOk();
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
    else if (act === 'chat') toggleChat();
    else if (act === 'vods') openVodsForContext();
    else if (act === 'browse') openBrowse();
    else if (act === 'dim') dimQuickKey();
  });
  // Pointing at the category chip offers to block it (see showCatPop).
  document.getElementById('ov-title').addEventListener('mouseover', function (e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute('data-catslug') && state.mode === 'player' && !state.vod) showCatPop(el);
  });
  document.getElementById('ov-title').addEventListener('mouseout', function (e) {
    var to = e.relatedTarget;
    if (!(to && to.getAttribute && to.getAttribute('data-catslug'))) leaveCatPop();
  });
  var ovcatPop = document.getElementById('ovcat-pop');
  ovcatPop.addEventListener('mouseenter', function () { clearTimeout(catPop.timer); catPop.hover = true; });
  ovcatPop.addEventListener('mouseleave', leaveCatPop);
  ovcatPop.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!catPop.slug) return;
    var nowBlocked = toggleCatBlock(catPop.slug, catPop.name || catPop.slug);
    toast((nowBlocked ? 'Blocked ' : 'Unblocked ') + (catPop.name || catPop.slug));
    hideCatPop();
    applyBlockedChange();
    armLiveOverlayHide();
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
  // VOD play/pause button and the -30/+30 skip buttons beside it
  // Hovering moves focus, the same way the sidebar and the grids behave, so the
  // pointer and the D-pad share one highlight rather than having two of their own.
  function hoverVodControl(id) {
    if (!state.vod) return;
    vodPointerHover = id;
    if (state.sidebarOpen) resetIdle();
  }
  function leaveVodControl() {
    if (!state.vod || vodPointerHover !== this.id) return;
    vodPointerHover = '';
    if (vodBarVisible()) armVodOverlayHide();
    if (state.sidebarOpen) resetIdle();
  }
  document.getElementById('vodbar').addEventListener('mouseenter', function () {
    hoverVodControl(this.id);
    focusVodBar();
  });
  document.getElementById('vodbar').addEventListener('mouseleave', leaveVodControl);
  for (var vb = 0; vb < VOD_BTN_IDS.length; vb++) {
    (function (i) {
      document.getElementById(VOD_BTN_IDS[i])
        .addEventListener('mouseenter', function () { hoverVodControl(this.id); focusVodButtons(i); });
      document.getElementById(VOD_BTN_IDS[i]).addEventListener('mouseleave', leaveVodControl);
    })(vb);
  }
  document.getElementById('vodplay').addEventListener('click', function (e) { e.stopPropagation(); toggleVodPlay(); });
  document.getElementById('vodback').addEventListener('click', function (e) { e.stopPropagation(); if (state.vod) seekVod(-30); });
  document.getElementById('vodfwd').addEventListener('click', function (e) { e.stopPropagation(); if (state.vod) seekVod(30); });
  document.getElementById('vodgolive').addEventListener('click', function (e) { e.stopPropagation(); goLive(); });
  // Live timeline: click to jump there, the chip to go live. Hovering holds it open.
  // Press anywhere on the track (the handle included) and drag: the bar previews
  // where you are pointing and the seek happens once, on release.
  var liveTrack = document.getElementById('livebar-track');
  var liveTrackRect = null, liveDragFrame = null, liveDragX = 0;
  function liveTrackTarget(clientX) {
    var p = livePositions();
    var r = liveTrackRect || liveTrack.getBoundingClientRect();
    if (!p || !(r.width > 0)) return null;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * p.edge;
  }
  // The handle is drawn past the ends of the track (at the live edge it sits
  // right beside the Go live slot), so the grab area is the whole bar, measured
  // against the track. Only Go live keeps its own press.
  function inside(el, id) { for (; el; el = el.parentNode) if (el.id === id) return true; return false; }
  document.getElementById('livebar').addEventListener('mousedown', function (e) {
    if (!state.current || state.vod || inside(e.target, 'livebar-live')) return;
    var tr = liveTrack.getBoundingClientRect();
    if (e.clientX < tr.left - 30 || e.clientX > tr.right + 30) return;   // the time label is not a grab
    e.preventDefault(); e.stopPropagation();
    resetLiveSeek();
    liveTrackRect = tr;
    liveBar.dragTarget = liveTrackTarget(e.clientX);
    clearTimeout(overlayTimer);
    clearTimeout(state.idleTimer);            // the list must not close mid-drag
    showLiveBar(true);
  });
  document.addEventListener('mousemove', function (e) {
    if (liveBar.dragTarget === null) return;
    liveDragX = e.clientX;
    if (liveDragFrame === null) liveDragFrame = requestAnimationFrame(function () {
      liveDragFrame = null;
      if (liveBar.dragTarget === null) return;
      var t = liveTrackTarget(liveDragX);
      if (t !== null) { liveBar.dragTarget = t; drawLiveBar(); }
    });
  });
  document.addEventListener('mouseup', function (e) {
    if (liveBar.dragTarget === null) return;
    var t = liveTrackTarget(e.clientX);
    if (t === null) t = liveBar.dragTarget;
    liveBar.dragTarget = null;
    liveTrackRect = null;
    if (liveDragFrame !== null) { cancelAnimationFrame(liveDragFrame); liveDragFrame = null; }
    seekLiveTo(t);
    if (state.sidebarOpen) resetIdle();
    else { var c = state.current && state.channels[state.current]; if (c) showOverlay(c); }
  });
  liveTrack.addEventListener('click', function (e) { e.stopPropagation(); });
  document.getElementById('livebar-live').addEventListener('click', function (e) { e.stopPropagation(); goLive(); });
  document.getElementById('livebar').addEventListener('click', function (e) { e.stopPropagation(); });
  document.getElementById('livebar').addEventListener('mouseenter', function () {
    liveBar.hover = true;
    clearTimeout(overlayTimer);
    if (state.sidebarOpen) clearTimeout(state.idleTimer);
    showLiveBar(true);
  });
  document.getElementById('livebar').addEventListener('mouseleave', function () {
    liveBar.hover = false;
    if (state.sidebarOpen) { resetIdle(); return; }
    armLiveOverlayHide();
  });
  // Dim options popup pointer
  var dimoptList = document.getElementById('dimopt-list');
  function dimoptIdx(e) {
    var el = e.target;
    while (el && el !== dimoptList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === dimoptList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) ? -1 : i;
  }
  bindSettingsListPointer(dimoptList, function (e) { var i = dimoptIdx(e); if (i >= 0 && i !== dimopt.focus) dimoptMove(i - dimopt.focus); });
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
  bindSettingsListPointer(chatoptList, function (e) { var i = chatoptIdx(e); if (i >= 0 && i !== chatopt.focus) { chatopt.focus = i; applyChatOptFocus(); } });
  chatoptList.addEventListener('click', function (e) {
    if (e.target.tagName === 'INPUT') return;
    var i = chatoptIdx(e); if (i < 0) return;
    chatopt.focus = i;
    chatoptActivate();
  });
  document.getElementById('chatopt-close').addEventListener('click', closeChatOpt);
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
  bindSettingsListPointer(blockedcatsList, function (e) {
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
  bindSettingsListPointer(qualityoptList, function (e) {
    var i = qualityoptIdx(e);
    if (i >= 0 && i !== qualityopt.focus) qualityoptMove(i - qualityopt.focus);
  });
  qualityoptList.addEventListener('click', function (e) {
    var i = qualityoptIdx(e);
    if (i >= 0) { qualityopt.focus = i; qualityoptActivate(); }
  });
  var qualityAlertSwitch = document.getElementById('qualityopt-alert');
  qualityAlertSwitch.addEventListener('mouseover', function () {
    if (qualityopt.open && qualityopt.focus !== -1) qualityoptMove(-1 - qualityopt.focus);
  });
  qualityAlertSwitch.addEventListener('click', function (e) {
    e.stopPropagation();
    if (qualityopt.open) toggleQualityAlert();
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
    if (i >= 0 && i !== chpop.idx) { chpop.idx = i; applyChpopFocus(); resetChpopTimer(); }
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
    if (state.vod && state.vod.liveRewind) { liveRewindEnded(); return; }
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
    setPosterStill(null);                           // real frames are on the plane now
    hideSpinner();
  });
  // loadeddata means a first frame exists, which is usually a touch earlier
  // than 'playing' — drop the still at whichever arrives first.
  video.addEventListener('loadeddata', function () { setPosterStill(null); });
  // Buffering spinner for both live and VOD.
  video.addEventListener('waiting', function () { resetVodRecovery(); if (!video.paused) showSpinnerSoon(); });
  video.addEventListener('seeking', function () { resetVodRecovery(); showSpinnerSoon(); });
  video.addEventListener('loadedmetadata', function () { if (state.vod) applyVodResume(); });
  video.addEventListener('durationchange', function () { if (state.vod) applyVodResume(); });
  video.addEventListener('canplay', function () { if (state.vod) applyVodResume(); hideSpinner(); });
  video.addEventListener('timeupdate', function () {
    if (state.vod) { trackVodRecovery(); saveVodProgress(false); }
    else { tickLiveWatch(); saveLiveMark(false); }
  });
  video.addEventListener('seeked', function () {
    hideSpinner();
    if (state.vod) saveVodProgress(true);
  });
  // Keep the VOD play/pause icon in sync with the actual state.
  video.addEventListener('play', function () { if (state.vod) vodPlayIcon(); });
  video.addEventListener('pause', function () {
    if (state.vod) { resetVodRecovery(); saveVodProgress(true); vodPlayIcon(); hideSpinner(); }
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
  if (document.hidden) {
    saveVodProgress(true); saveLiveMark(true); pauseNotify();
    // Nobody is reading chat while another app is in front; parsing a busy room
    // for hours is wasted CPU. The setting is untouched, so it reconnects on return.
    if (chat.want) disconnectChat();
    // Another app owns the screen. Polling on regardless costs a Luna round trip for
    // every channel every ninety seconds for nobody; the visible branch below already
    // refetches on the way back, so nothing goes stale.
    stopPlayerPoll();
    return;
  }
  if (state.ready) startPlayerPoll();
  flushChatRender();
  if (state.current && !state.vod) syncChat();   // reconnect what the background dropped
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
  return document.hidden || state.mode !== 'player' || state.sidebarOpen || saver.on || anyPanelOpen();
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
      // Something else started, or the viewer took over after the boot deadline.
      if (state.current || state.vod || (state.ready && bootChoiceSuperseded())) return;
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
  // Relaunched within the last link's lifetime: start on it without a lookup.
  var cached = state.channels[last], url = recallPlayback(last);
  if (url && cached && cached.live) {
    cached.playbackUrl = url;
    play(last);
    done(true);
    return;
  }
  apiGet(last, function (err, raw) {
    // A slow lookup can land long after the boot deadline handed over control.
    if (state.current || state.vod || (state.ready && bootChoiceSuperseded())) { done(true); return; }
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
  prepareSidebarSoon();
  setTimeout(function () { warmPreviews(false); }, 3000);   // after playback has its start
  return true;
}
// True once the viewer (or the deadline's idle screen) owns what is on screen, so
// a late startup decision must not yank them somewhere else.
function bootChoiceSuperseded() {
  return !!(state.current || state.vod || state.sidebarOpen || state.mode !== 'player' || anyPanelOpen());
}
(function boot() {
  setMode('player');
  loadQualityPref();
  loadSettings();
  ChatWindow.init();
  if (window.UIPolish) UIPolish.init();
  getFirstRun();      // stamp the baseline before any offline row can render
  loadChannelCache();                         // instant sidebar/home data while the real fetch runs
  applyDim();
  applyChatStyle();                           // apply chat appearance and layout
  syncDiagnostics();
  loadAppVersion();                           // populate the version chip in Settings promptly
  setTimeout(checkForUpdate, 3000);           // check GitHub for a newer release, once the app has settled
  state.lastInput = Date.now();
  setInterval(checkSaver, 1000);              // burn-in guard checks in every second — see checkSaver
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
