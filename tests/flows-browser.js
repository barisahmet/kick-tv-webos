window.runFlowsTests = async function (assert) {
  var api = apiGet, transport = serviceGet, live = attachStream, vod = attachVod;
  var pending = [], attached = [];
  function raw(name) { return { id: 42, user: { username: name }, livestream: { is_live: true }, playback_url: 'https://fixture.invalid/live', chatroom: { id: 1 } }; }
  apiGet = function (slug, cb) { pending.push({ slug: slug, cb: cb }); };
  serviceGet = function (path, cb) { pending.push({ path: path, cb: cb }); };
  attachStream = function (slug) { attached.push(slug); };
  attachVod = function () {};
  try {
    play('alpha'); play('beta');
    pending[0].cb(null, raw('Old Alpha'));
    assert(attached.length === 0 && state.current === 'beta', 'late channel lookup cannot replace a newer selection');
    pending[1].cb(null, raw('Beta'));
    assert(attached.join(',') === 'beta', 'new channel starts when its own lookup completes');
    play('alpha'); play('alpha');
    pending[2].cb(null, raw('Stale Alpha'));
    assert(attached.length === 1, 'same-channel reselection also invalidates the old playback session');
    pending[3].cb(null, raw('Fresh Alpha'));
    assert(attached.join(',') === 'beta,alpha', 'only the current same-channel session starts');
    returnToIdle(); closeSidebar();
    var item = { video: { uuid: 'recording' }, source: 'https://fixture.invalid/vod.m3u8', duration: 1000000, session_title: 'Recording' };
    saveLastVod('alpha', item, 'Alpha');
    localStorage.setItem(VOD_PROGRESS_KEY, JSON.stringify({ version: 1, items: { 'alpha:recording': { position: 120, duration: 1000 } } }));
    vodProgressMemo = null;
    var result;
    resumeLastVodAtStartup(function (resumed, retryable) { result = { resumed: resumed, retryable: retryable }; });
    pending[4].cb('network');
    assert(result.retryable && loadLastVod().id === 'recording', 'temporary VOD lookup failure preserves the startup marker');
    resumeLastVodAtStartup(function (resumed, retryable) { result = { resumed: resumed, retryable: retryable }; });
    pending[5].cb(null, [item]);
    assert(result.resumed && state.vod.key === 'alpha:recording' && state.vod.resumeAt === 120, 'startup resolves the stable recording and restores its saved position');
    var video = document.getElementById('video');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    Object.defineProperty(video, 'duration', { configurable: true, value: 1000 });
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 });
    video.dispatchEvent(new Event('timeupdate'));
    assert(savedVodPosition('alpha:recording') === 120, 'old zero-position media events do not erase a pending resume');
    video.dispatchEvent(new Event('loadedmetadata'));
    assert(video.currentTime === 120 && state.vod.resumeApplied, 'metadata applies the saved resume point');
    video.currentTime = 140; video.dispatchEvent(new Event('seeked'));
    assert(savedVodPosition('alpha:recording') === 140, 'new playback progress is saved after resume');
    returnToIdle(); closeSidebar();
    saveLastVod('alpha', item, 'Alpha');
    resumeLastVodAtStartup(function (resumed, retryable) { result = { resumed: resumed, retryable: retryable }; });
    state.current = 'beta'; pending[6].cb(null, [item]);
    assert(state.current === 'beta' && !state.vod && !result.resumed, 'late startup recovery cannot interrupt a user-selected live channel');
    delete video.readyState; delete video.duration; delete video.currentTime;
  } finally { apiGet = api; serviceGet = transport; attachStream = live; attachVod = vod; }
};
