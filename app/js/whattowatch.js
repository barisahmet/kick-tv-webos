'use strict';
/* What to watch: a compact popup over the player tools listing the newest past
   videos of the streamers you watch most. "Most" is real viewing time, live and
   past videos together, counted only while the picture is actually playing. */
var WATCHTIME_KEY = 'kicktv.watchtime';
var WATCHTIME_TICK_MS = 15000;
var WATCHTIME_LIMIT = 150;           // streamers remembered; the least watched fall off
var WTW_STREAMERS = 6;               // how many top streamers feed the list
var WTW_MAX_ITEMS = 40;
var WTW_MAX_AGE_MS = 30 * 24 * 3600 * 1000;   // older recordings are rarely still up anyway
var watchTickAt = 0;

function loadWatchTime() {
  var v = null;
  try { v = JSON.parse(localStorage.getItem(WATCHTIME_KEY)); } catch (e) {}
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}
// Credit the time since the last tick to whatever is on screen. A gap longer than
// two ticks means the TV slept or the app was in the background: not viewing.
function tickWatchTime() {
  var now = Date.now(), gap = now - watchTickAt;
  watchTickAt = now;
  if (gap <= 0 || gap > WATCHTIME_TICK_MS * 2 || document.hidden) return;
  var video = document.getElementById('video');
  if (!video || video.paused || video.readyState < 3) return;
  var slug = state.vod ? state.vod.slug : state.current;
  if (!slug) return;
  var data = loadWatchTime(), e = data[slug] || { s: 0, t: 0 };
  e.s = Math.round((e.s || 0) + gap / 1000); e.t = now;
  data[slug] = e;
  var slugs = Object.keys(data);
  if (slugs.length > WATCHTIME_LIMIT) {
    slugs.sort(function (a, b) { return (data[b].s || 0) - (data[a].s || 0); });
    slugs.slice(WATCHTIME_LIMIT).forEach(function (s) { delete data[s]; });
  }
  try { localStorage.setItem(WATCHTIME_KEY, JSON.stringify(data)); } catch (err) {}
}
setInterval(tickWatchTime, WATCHTIME_TICK_MS);

// Most watched first. Until there is history, fall back on what past-video
// progress already says you watch, then on pins, then on the follow list.
function topWatchedStreamers(n) {
  var score = {}, order = [];
  function bump(slug, v) {
    if (!slug) return;
    if (!(slug in score)) { score[slug] = 0; order.push(slug); }
    score[slug] += v;
  }
  var wt = loadWatchTime();
  Object.keys(wt).forEach(function (s) { bump(s, (wt[s].s || 0) * 1000); });
  var items = loadVodProgress().items || {};
  Object.keys(items).forEach(function (k) {
    var pos = parseFloat(items[k] && items[k].position);
    bump(k.split(':')[0], isFinite(pos) && pos > 0 ? pos : 1);
  });
  getPinned().forEach(function (s) { bump(s, 0.5); });
  getFavorites().forEach(function (s) { bump(s, 0); });
  order.sort(function (a, b) { return score[b] - score[a] || order.indexOf(a) - order.indexOf(b); });
  return order.slice(0, n);
}

var wtw = { open: false, focus: 0, items: [], loading: false, session: 0 };
function openWhatToWatch() {
  if (!state.ready || wtw.open) return;
  wtw.open = true; wtw.session++; wtw.focus = 0; wtw.items = []; wtw.loading = true;
  clearTimeout(state.idleTimer);                 // keep the tools behind the popup
  hideQualityHint();
  sidePreviewCard.cancel();
  document.getElementById('wtwmodal').className = '';
  renderWhatToWatch();
  loadWhatToWatch(wtw.session);
}
function closeWhatToWatch() {
  wtw.open = false;
  document.getElementById('wtwmodal').className = 'hidden';
  if (state.sidebarOpen) { resetIdle(); scheduleSidePreview(); }
  pumpNotify();
}
function loadWhatToWatch(ses) {
  var slugs = topWatchedStreamers(WTW_STREAMERS), pending = slugs.length, found = [];
  if (!pending) { wtw.loading = false; renderWhatToWatch(); return; }
  function done() {
    if (--pending > 0 || ses !== wtw.session || !wtw.open) return;
    var cutoff = Date.now() - WTW_MAX_AGE_MS;
    var progress = loadVodProgress().items || {};
    // finished ones (90% or more) are not something to watch any more
    found = found.filter(function (it) {
      return (parseKickTime(it.v.created_at) || 0) >= cutoff && !vodWatchedInfo(it.slug, it.v, progress).watched;
    });
    found.sort(function (a, b) { return (parseKickTime(b.v.created_at) || 0) - (parseKickTime(a.v.created_at) || 0); });
    wtw.items = found.slice(0, WTW_MAX_ITEMS);
    wtw.loading = false;
    renderWhatToWatch();
  }
  slugs.forEach(function (slug) {
    // reuse a list the Past videos screen fetched in the last few minutes
    var cached = vodCatalogueCache['$' + slug];
    if (cached && Date.now() - cached.loadedAt < 300000 && cached.list) {
      addStreamerVods(slug, cached.list.filter(function (v) { return !v.catalogueTerminal; }));
      done(); return;
    }
    serviceGet('/api/v2/channels/' + encodeURIComponent(slug) + '/videos', function (err, data) {
      if (!err && Array.isArray(data)) {
        var list = [];
        data.forEach(function (src) { if (src && playableVod(src)) list.push(vodEntryOf(src)); });
        addStreamerVods(slug, list);
      }
      done();
    }, { priority: 1 });
  });
  function addStreamerVods(slug, list) {
    // Kick lists the stream that is on right now too; that one belongs to live.
    var queue = list.filter(function (v) { return !v.is_live; });
    queue.forEach(function (v, i) { found.push({ slug: slug, v: v, queue: queue, index: i }); });
  }
}
function renderWhatToWatch() {
  var list = document.getElementById('wtw-list');
  list.innerHTML = '';
  if (!wtw.items.length) {
    var empty = document.createElement('div');
    empty.className = 'wtw-empty';
    empty.textContent = wtw.loading ? 'Finding past videos...' : 'No past videos from the streamers you watch most.';
    list.appendChild(empty);
    return;
  }
  var progress = loadVodProgress().items || {};
  wtw.items.forEach(function (it, i) {
    var info = vodWatchedInfo(it.slug, it.v, progress);
    var row = document.createElement('div');
    row.className = 'wtw-row' + (info.watched ? ' watched' : '') + (i === wtw.focus ? ' focused' : '');
    row.setAttribute('data-idx', i);
    var top = document.createElement('div'); top.className = 'wtw-top';
    var who = document.createElement('span'); who.className = 'wtw-who';
    who.textContent = (state.channels[it.slug] && state.channels[it.slug].name) || it.slug;
    var meta = document.createElement('span'); meta.className = 'wtw-meta';
    meta.textContent = fmtVodAgo(it.v.created_at) + (it.v.duration ? ' · ' + fmtDuration(it.v.duration) : '') +
      (info.watched ? ' · Watched' : info.frac > 0 ? ' · ' + Math.max(1, Math.round(info.frac * 100)) + '% watched' : '');
    top.appendChild(who); top.appendChild(meta);
    var title = document.createElement('div'); title.className = 'wtw-title';
    title.textContent = it.v.session_title || 'Past video';
    row.appendChild(top); row.appendChild(title);
    if (!info.watched && info.frac > 0) {
      var bar = document.createElement('div'); bar.className = 'wtw-bar';
      var fill = document.createElement('div'); fill.style.width = Math.round(info.frac * 100) + '%';
      bar.appendChild(fill); row.appendChild(bar);
    }
    list.appendChild(row);
  });
  var f = list.children[wtw.focus];
  if (f) scrollIntoViewport(list, f, 6);
}
function wtwMove(delta) {
  var n = wtw.focus + delta;
  if (n < 0 || n >= wtw.items.length) return;
  var list = document.getElementById('wtw-list');
  if (list.children[wtw.focus]) list.children[wtw.focus].classList.remove('focused');
  wtw.focus = n;
  if (list.children[n]) { list.children[n].classList.add('focused'); scrollIntoViewport(list, list.children[n], 6); }
}
function wtwActivate() {
  var it = wtw.items[wtw.focus];
  if (!it) return;
  closeWhatToWatch();
  if (state.sidebarOpen) closeSidebar();
  // the streamer's own list is the queue, so auto-advance stays with them
  playVod(it.v, it.queue, it.index, it.slug);
}
function wtwKey(k) {
  if (k === KEY.BACK || k === KEY.LEFT) closeWhatToWatch();
  else if (k === KEY.UP) wtwMove(-1);
  else if (k === KEY.DOWN) wtwMove(1);
  else if (k === KEY.OK || k === KEY.RIGHT) wtwActivate();
}
