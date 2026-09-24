/* Live timeline and Go live, against synthetic fixtures only. */
window.runLivebarTests = async function (assert) {
  function kickTime(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }
  function key(code) { document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })); }
  var saved = { serviceGet: serviceGet, playVod: playVod, exitVod: exitVod, attachVod: attachVod };
  var requests = [], played = null, exited = 0, attached = null;
  try {
    var startedMs = Date.now() - 3600 * 1000;
    state.channels.alpha.startedAt = kickTime(startedMs);
    serviceGet = function (path, cb) { requests.push({ path: path, cb: cb }); return function () {}; };
    playVod = function (v, queue, index, slug, opts) { played = { v: v, slug: slug, opts: opts }; };

    key(13);
    assert(liveBarVisible() && liveBar.focused, 'OK on a live stream shows the timeline focused');
    var p = livePositions();
    assert(p && Math.abs(p.edge - 3600) < 5, 'the timeline spans from the stream start to now');
    assert(document.getElementById('livebar-live').className === 'hidden' && document.getElementById('livebar-end').className === '',
      'at the live edge the right end shows the running time, no Go live');
    var trackWidth = document.getElementById('livebar-track').getBoundingClientRect().width;

    key(37);
    assert(liveSeek.base !== null && liveSeek.delta === -30, 'Left collects a 30s step back');
    assert(document.getElementById('seekpop').className === '', 'the pending jump is announced');
    assert(document.getElementById('livebar-origin').getAttribute('visibility') === 'visible', 'the bar marks where the seek started');
    assert(document.getElementById('livebar-live').className === '' && document.getElementById('livebar-end').className === 'hidden',
      'a pending step back offers Go live in the same slot');
    assert(Math.abs(document.getElementById('livebar-track').getBoundingClientRect().width - trackWidth) < 1,
      'the track keeps its length when Go live appears');
    key(39); key(39);
    assert(liveSeek.delta <= 0.5, 'Right cannot bank seconds past the live edge');
    key(37); key(37);
    await fixtureWait(SEEK_APPLY_MS + 120);
    var videos = requests.filter(function (r) { return r.path.indexOf('/videos') !== -1; });
    assert(videos.length === 1, 'a rewind past the live buffer looks up the stream recording');
    videos[0].cb(null, [
      { is_live: false, created_at: kickTime(startedMs - 86400000), source: 'https://fixture.invalid/old.m3u8', duration: 1000 },
      { is_live: true, created_at: state.channels.alpha.startedAt, source: 'https://fixture.invalid/rec.m3u8', duration: 0, video: { uuid: 'rec' } }
    ]);
    assert(played && played.v.source.indexOf('rec.m3u8') !== -1, 'the running stream\'s own recording is opened, not an old one');
    assert(played.opts.liveRewind && Math.abs(played.opts.resumeAt - (3600 - 60)) < 5, 'it opens at the chosen moment');
    assert(state.vodReturn === 'alpha', 'Go live will return to the same channel');

    // The playlist clock corrects the created_at estimate.
    var fakeHls = {};
    state.hls = fakeHls;
    state.vod = { liveRewind: true, slug: 'alpha', key: 'alpha:rec', wallTarget: startedMs + 1000 * 1000, resumeApplied: false, resumeAt: 0 };
    liveRewindLevelLoaded(fakeHls, { details: { totalduration: 3500, fragments: [{ programDateTime: startedMs - 6000 }] } });
    assert(Math.abs(state.vod.resumeAt - 1006) < 0.01 && state.vod.wallTarget === 0, 'segment timestamps pin the exact position once');
    assert(state.vod.recEndMs === startedMs - 6000 + 3500 * 1000, 'the loaded copy knows where it ends');

    var writes = fixtureWrites[VOD_PROGRESS_KEY] || 0;
    state.vod.progressReady = true; state.vod.resumeApplied = true;
    saveVodProgress(true);
    assert((fixtureWrites[VOD_PROGRESS_KEY] || 0) === writes, 'a rewound live stream keeps no resume progress');
    assert(vodBtnCount() === 4, 'the transport row gains Go live while rewound');
    showVodBar();
    assert(document.getElementById('vodgolive').className !== 'hidden' && document.getElementById('vodbar-dur').className === 'hidden',
      'Go live replaces the duration at the right end of the seek bar');
    hideVodBar();

    exitVod = function () { exited++; };
    attachVod = function (src) { attached = src; };
    state.vod.source = 'https://fixture.invalid/rec.m3u8';
    state.vod.recEndMs = Date.now() - 10 * 60000;
    liveRewindEnded();
    assert(attached && exited === 0, 'reaching the end of a stale copy reloads the grown recording');
    liveRewindEnded();
    assert(exited === 1, 'a copy that did not grow means we caught up: go live');
    state.vod.recEndMs = Date.now() - 5000; delete state.vod.endReloadDur;
    liveRewindEnded();
    assert(exited === 2, 'ending near the live edge goes live');
    state.vod = null; state.hls = null; hideVodPlay();

    // Back on live: REW rewinds, FF with nothing pending goes live, Back tucks it away.
    showOverlay(state.channels.alpha);
    key(412);
    assert(liveSeek.base !== null && liveSeek.delta === -60, 'the rewind key steps back a minute');
    key(417);
    assert(liveSeek.delta === 0, 'fast-forward walks the pending jump forward');
    resetLiveSeek();
    key(417);
    assert(liveSeek.base === null, 'fast-forward with nothing pending just goes live');
    liveBar.focused = true; showLiveBar(true);
    key(461);
    assert(!liveBarVisible() && !state.sidebarOpen, 'Back puts the timeline away before anything else');
    key(37);
    assert(state.sidebarOpen, 'with the timeline away, Left opens the channel list as before');
    closeSidebar();
    assert(!liveBarVisible(), 'closing the list hides the timeline with the info bar');

    // Dragging the handle with the pointer previews, then seeks once on release.
    played = null; requests = [];
    showOverlay(state.channels.alpha);
    var track = document.getElementById('livebar-track'), r = track.getBoundingClientRect();
    function mouse(type, x, target) {
      (target || document).dispatchEvent(new MouseEvent(type, { clientX: x, clientY: r.top + r.height / 2, bubbles: true }));
    }
    mouse('mousedown', r.right + 12, document.getElementById('livebar'));
    assert(liveBar.dragTarget !== null, 'grabbing the handle where it overhangs the track end starts a drag');
    mouse('mouseup', r.right + 12); requests = [];
    mouse('mousedown', r.left - 80, document.getElementById('livebar-cur'));
    assert(liveBar.dragTarget === null, 'pressing the time label does not seek');
    mouse('mousedown', r.right - 2, track);
    assert(liveBar.dragTarget !== null && liveBarVisible(), 'pressing on the track starts a drag');
    mouse('mousemove', r.left + r.width / 2);
    await fixtureWait(40);
    assert(Math.abs(liveBar.dragTarget - livePositions().edge / 2) < 60, 'the drag follows the pointer');
    assert(document.getElementById('livebar-origin').getAttribute('visibility') === 'visible', 'a drag previews against where playback is');
    assert(!state.sidebarOpen, 'dragging does not pull the channel list open');
    mouse('mouseup', r.left + r.width / 2);
    assert(liveBar.dragTarget === null, 'release ends the drag');
    assert(requests.filter(function (q) { return q.path.indexOf('/videos') !== -1; }).length === 1, 'release seeks once, into the recording');
  } finally {
    serviceGet = saved.serviceGet; playVod = saved.playVod; exitVod = saved.exitVod; attachVod = saved.attachVod;
  }
};
