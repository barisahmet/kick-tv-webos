'use strict';
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
  if (state.tempChannel) rememberRecent(slug);   // offered back by the Add dialog
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

