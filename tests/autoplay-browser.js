window.runAutoplayTests = function (assert) {
  var originalPlay = playVod, played = [], realNow = Date.now, now = realNow();
  playVod = function (v) { played.push(v.id); if (typeof cancelVodNext === "function") cancelVodNext(); };
  Date.now = function () { return now; };
  var queue = ['first', 'watched', 'next'].map(function (id) { return { id: id, source: 'https://fixture.test/' + id, duration: 1000000, session_title: id }; });
  function ended() { state.current = null; state.vod = { slug: 'alpha', markerId: 'first', key: 'alpha:first', queue: queue, queueIndex: 0, completed: true, ending: true }; }
  try {
    settings.autoadvance = true; settings.autoSkipWatched = true;
    writeVodProgress({ version: 1, items: { 'alpha:watched': { watched: true, position: 0 } } });
    ended(); advanceVodOrExit();
    assert(played.length === 0, 'ending a recording offers a countdown instead of starting the next video immediately');
    assert(vodNext.open && /next/.test(document.getElementById('vod-next-title').textContent), 'the countdown skips an already watched recording');
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: KEY.BACK, bubbles: true }));
    now += 20000; tickVodNext();
    assert(played.length === 0 && !vodNext.open, 'remote Back cancels automatic playback even after the deadline');
    ended(); advanceVodOrExit(); now += 11000; tickVodNext();
    assert(played.join(',') === 'next' && !vodNext.open, 'elapsed countdown starts the next unwatched video exactly once');
    tickVodNext(); assert(played.length === 1, 'repeated timer ticks cannot start the next video twice');
    settings.autoSkipWatched = false;
    ended(); advanceVodOrExit(); document.getElementById('vod-next-play').click();
    assert(played.join(',') === 'next,watched', 'Play now respects the option to include watched recordings');
    ended(); advanceVodOrExit(); teardownVideo(); state.vod = null; state.current = 'beta';
    now += 20000; tickVodNext();
    assert(played.length === 2 && !vodNext.open, 'switching playback cancels the old countdown');
    ended(); advanceVodOrExit();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); tickVodNext(); delete document.hidden;
    assert(!vodNext.open && played.length === 2, 'backgrounding the app cancels automatic playback');
    ended(); advanceVodOrExit(); dismissVodNext();
    var video = document.getElementById('video');
    Object.defineProperty(video, 'ended', { configurable: true, value: false });
    video.dispatchEvent(new Event('seeking')); delete video.ended;
    assert(!state.vod.completed && !state.vod.ending && loadLastVod().id === 'first', 'seeking back after cancelling re-enables recording playback and startup recovery');
    settings.autoSkipWatched = true; saveSettings(); settings.autoSkipWatched = false; loadSettings();
    assert(settings.autoSkipWatched === true, 'skip-watched preference persists across settings reload');
  } finally { if (typeof cancelVodNext === 'function') cancelVodNext(); Date.now = realNow; playVod = originalPlay; state.vod = null; delete document.hidden; }
};
window.setupAutoplayScreenshot = function () {
  settings.autoadvance = true;
  state.vod = { slug: 'alpha', queue: [], completed: true };
  showVodNext(state.vod, { item: { session_title: 'Evening stream — conversations and community games' }, index: 1 });
  clearInterval(vodNext.timer);
};
