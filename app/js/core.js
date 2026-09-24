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

