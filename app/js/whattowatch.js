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

var wtw = { open: false, focus: 0, items: [], loading: false, session: 0,
  mode: 'suggested', zone: 'list', requests: [], opening: false };
function cancelWtwRequests() {
  wtw.session++;
  wtw.requests.forEach(function (r) { if (typeof r === 'function') r(); else if (r && r.cancel) r.cancel(); });
  wtw.requests = []; wtw.opening = false;
}
function openWhatToWatch(mode) {
  if (!state.ready || wtw.open) return;
  saveVodProgress(true);
  wtw.open = true;
  clearTimeout(state.idleTimer);
  hideQualityHint(); sidePreviewCard.cancel();
  document.getElementById('wtwmodal').className = '';
  wtwSelect(mode || 'suggested');
}
function closeWhatToWatch() {
  cancelWtwRequests();
  wtw.open = false;
  document.getElementById('wtwmodal').className = 'hidden';
  if (state.sidebarOpen) { resetIdle(); scheduleSidePreview(); }
  pumpNotify();
}
function wtwSelect(mode) {
  cancelWtwRequests();
  wtw.mode = mode; wtw.focus = 0; wtw.zone = 'list'; wtw.items = [];
  wtw.loading = mode === 'suggested';
  document.getElementById('wtw-status').textContent = '';
  document.getElementById('wtw-list').scrollTop = 0;
  if (mode === 'resume') wtw.items = listResumableVods(Infinity);
  renderWhatToWatch();
  if (wtw.loading) loadWhatToWatch(wtw.session);
}
function loadWhatToWatch(ses) {
  var slugs = topWatchedStreamers(WTW_STREAMERS), pending = slugs.length, found = [], failures = 0;
  if (!pending) { wtw.loading = false; renderWhatToWatch(); return; }
  function done() {
    if (--pending > 0 || ses !== wtw.session || !wtw.open) return;
    var cutoff = Date.now() - WTW_MAX_AGE_MS, progress = loadVodProgress().items || {};
    found = found.filter(function (it) {
      return (parseKickTime(it.v.created_at) || 0) >= cutoff && !vodWatchedInfo(it.slug, it.v, progress).watched;
    });
    found.sort(function (a, b) { return (parseKickTime(b.v.created_at) || 0) - (parseKickTime(a.v.created_at) || 0); });
    wtw.items = found.slice(0, WTW_MAX_ITEMS);
    if (failures) wtw.items.push({ retry: true, partial: wtw.items.length > 0 });
    wtw.loading = false; renderWhatToWatch();
  }
  slugs.forEach(function (slug) {
    var cached = vodCatalogueCache['$' + slug];
    if (cached && Date.now() - cached.loadedAt < 300000 && cached.list && !cached.error) {
      addStreamerVods(slug, cached.list.filter(function (v) { return !v.catalogueTerminal; }));
      done(); return;
    }
    wtw.requests.push(serviceGet('/api/v2/channels/' + encodeURIComponent(slug) + '/videos', function (err, data) {
      if (ses !== wtw.session || !wtw.open) return;
      if (!err && Array.isArray(data)) {
        var list = [];
        data.forEach(function (src) { if (src && playableVod(src)) list.push(vodEntryOf(src)); });
        addStreamerVods(slug, list);
      } else failures++;
      done();
    }, { priority: 1 }));
  });
  function addStreamerVods(slug, list) {
    var queue = list.filter(function (v) { return !v.is_live; });
    queue.forEach(function (v, i) { found.push({ slug: slug, v: v, queue: queue, index: i }); });
  }
}
function renderWhatToWatch() {
  var resume = wtw.mode === 'resume', list = document.getElementById('wtw-list');
  document.getElementById('wtw-sub').textContent = resume ? 'Your unfinished videos' : 'Past videos from who you watch most';
  ['suggested', 'resume'].forEach(function (mode) {
    var tab = document.getElementById('wtw-' + mode);
    tab.className = 'wtw-tab' + (mode === wtw.mode ? ' selected' : '') + (wtw.zone === 'tabs' && mode === wtw.mode ? ' focused' : '');
    tab.setAttribute('aria-selected', mode === wtw.mode ? 'true' : 'false');
  });
  list.innerHTML = '';
  if (!wtw.items.length) {
    var empty = document.createElement('div'); empty.className = 'wtw-empty';
    empty.textContent = wtw.loading ? 'Finding past videos...' : resume ? 'No unfinished videos yet.' : 'No past videos from the streamers you watch most.';
    list.appendChild(empty); return;
  }
  var progress = loadVodProgress().items || {};
  wtw.items.forEach(function (it, i) {
    var row = document.createElement('div');
    row.className = 'wtw-row' + (i === wtw.focus && wtw.zone === 'list' ? ' focused' : '');
    row.setAttribute('data-idx', i);
    if (it.retry) {
      row.textContent = (it.partial ? 'Some videos could not be loaded.' : 'Could not load videos. Check your connection.') + ' Retry';
      row.classList.add('wtw-retry'); list.appendChild(row); return;
    }
    var info = resume ? { frac: it.entry.duration ? it.entry.position / it.entry.duration : 0 } : vodWatchedInfo(it.slug, it.v, progress);
    var top = document.createElement('div'); top.className = 'wtw-top';
    var who = document.createElement('span'); who.className = 'wtw-who';
    who.textContent = (resume && it.entry.name) || (state.channels[it.slug] && state.channels[it.slug].name) || it.slug;
    var meta = document.createElement('span'); meta.className = 'wtw-meta';
    meta.textContent = resume ? fmtClock(it.entry.position) + (it.entry.duration ? ' / ' + fmtClock(it.entry.duration) : '') :
      fmtVodAgo(it.v.created_at) + (it.v.duration ? ' · ' + fmtDuration(it.v.duration) : '') +
      (info.frac > 0 ? ' · ' + Math.max(1, Math.round(info.frac * 100)) + '% watched' : '');
    top.appendChild(who); top.appendChild(meta);
    var title = document.createElement('div'); title.className = 'wtw-title';
    title.textContent = (resume ? it.entry.title : it.v.session_title) || 'Past video';
    row.appendChild(top); row.appendChild(title);
    if (info.frac > 0) {
      var bar = document.createElement('div'); bar.className = 'wtw-bar';
      var fill = document.createElement('div'); fill.style.width = Math.min(100, Math.round(info.frac * 100)) + '%';
      bar.appendChild(fill); row.appendChild(bar);
    }
    if (resume) {
      var remove = document.createElement('button'); remove.className = 'wtw-remove';
      remove.setAttribute('data-remove', 'true'); remove.setAttribute('aria-label', 'Remove from Continue watching');
      remove.textContent = 'Remove'; row.appendChild(remove); row.classList.add('wtw-resume-row');
    }
    list.appendChild(row);
  });
  var f = list.children[wtw.focus]; if (f && wtw.zone === 'list') scrollIntoViewport(list, f, 6);
}
function wtwMove(delta) {
  var n = wtw.focus + delta;
  if (wtw.zone === 'tabs') { if (delta > 0) { wtw.zone = 'list'; renderWhatToWatch(); } return; }
  if (n < 0) { wtw.zone = 'tabs'; renderWhatToWatch(); return; }
  if (n >= wtw.items.length) return;
  var list = document.getElementById('wtw-list');
  if (list.children[wtw.focus]) list.children[wtw.focus].classList.remove('focused');
  wtw.focus = n;
  if (list.children[n]) { list.children[n].classList.add('focused'); scrollIntoViewport(list, list.children[n], 6); }
}
function removeWtwResume() {
  var it = wtw.items[wtw.focus];
  if (wtw.mode !== 'resume' || !it || wtw.zone !== 'list') return;
  cancelWtwRequests();
  var data = loadVodProgress();
  if (data.items[it.key]) { data.items[it.key].dismissed = true; writeVodProgress(data); }
  wtw.items = listResumableVods(Infinity); wtw.focus = Math.max(0, Math.min(wtw.focus, wtw.items.length - 1));
  document.getElementById('wtw-status').textContent = 'Removed from Continue watching. Playback progress kept.';
  renderWhatToWatch(); renderHome();
}
function wtwActivate() {
  if (wtw.zone === 'tabs') { wtw.zone = 'list'; renderWhatToWatch(); return; }
  var it = wtw.items[wtw.focus];
  if (!it || wtw.opening) return;
  if (it.retry) { wtwSelect('suggested'); return; }
  if (wtw.mode === 'resume') {
    var ses = wtw.session, current = state.current, vod = state.vod;
    wtw.opening = true; document.getElementById('wtw-status').textContent = 'Opening video...';
    wtw.requests.push(serviceGet('/api/v2/channels/' + encodeURIComponent(it.slug) + '/videos', function (err, data) {
      if (!wtw.open || wtw.session !== ses) return;
      wtw.opening = false;
      if (wtw.items[wtw.focus] !== it || state.current !== current || state.vod !== vod) {
        document.getElementById('wtw-status').textContent = ''; return;
      }
      var list = !err && Array.isArray(data) ? data.filter(playableVod) : [];
      for (var i = 0; i < list.length; i++) {
        if (vodStableId(list[i]) === String(it.id)) { start(list[i], list, i); return; }
      }
      document.getElementById('wtw-status').textContent = err || !Array.isArray(data) ? 'Could not load video. Select it to retry.' : 'This video is no longer available. You can remove it from the list.';
    }, { priority: 0 }));
    return;
  }
  start(it.v, it.queue, it.index);
  function start(v, queue, index) {
    var back = state.current || state.vodReturn;
    closeWhatToWatch(); if (state.sidebarOpen) closeSidebar();
    state.vodReturn = back;
    playVod(v, queue, index, it.slug);
  }
}
function wtwKey(k) {
  if (k === KEY.BACK) closeWhatToWatch();
  else if (k === KEY.LEFT || k === KEY.RIGHT) { wtwSelect(k === KEY.LEFT ? 'suggested' : 'resume'); wtw.zone = 'tabs'; renderWhatToWatch(); }
  else if (k === KEY.UP) wtwMove(-1);
  else if (k === KEY.DOWN) wtwMove(1);
  else if (k === KEY.OK) wtwActivate();
}
