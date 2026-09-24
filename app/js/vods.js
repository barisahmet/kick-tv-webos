'use strict';
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
// The fields the app keeps from one of Kick's /videos records.
function vodEntryOf(src) {
  return { id: src.id, uuid: src.uuid, video: src.video ? { id: src.video.id, uuid: src.video.uuid, thumb: src.video.thumb } : null,
    source: src.source, session_title: src.session_title || '', duration: src.duration || 0, views: src.views || 0,
    thumbnail: src.thumbnail || null, categories: src.categories && src.categories[0] ? [{ name: src.categories[0].name || '', slug: src.categories[0].slug || '' }] : [],
    created_at: src.created_at || '', is_live: !!src.is_live };
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
      if (all.length < VOD_CATALOGUE_LIMIT) all.push(vodEntryOf(src));
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
  // with the sidebar open the player tools column stands at the right; stop short of it
  player.style.setProperty('--vod-right', state.sidebarOpen ? '380px' : '60px');
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

