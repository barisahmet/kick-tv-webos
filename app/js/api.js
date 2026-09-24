'use strict';
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

