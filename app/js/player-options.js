'use strict';
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

