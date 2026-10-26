window.runBackupTests = function (assert) {
  var timer = window.setTimeout, reload = null;
  // Capture only the intended restart; keep the real pagehide handler active.
  window.setTimeout = function (fn, ms) { if (ms === 800) { reload = fn; return 0; } return timer.apply(window, arguments); };
  var video = document.getElementById('video');
  try {
    var oldProgress = { version: 1, items: { 'alpha:old': { position: 100, duration: 1000 } } };
    localStorage.setItem(VOD_PROGRESS_KEY, JSON.stringify(oldProgress)); vodProgressMemo = null; loadVodProgress();
    state.vod = { key: 'alpha:old', slug: 'alpha', progressReady: true, resumeAt: 0 };
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 200 });
    Object.defineProperty(video, 'duration', { configurable: true, value: 1000 });
    var next = { 'kicktv.added': '["restored-channel"]', 'kicktv.vodprogress': JSON.stringify({ version: 1, items: { 'restored:new': { position: 500, duration: 1000 } } }) };
    applyBackupReplace(next);
    assert(!!reload && JSON.parse(localStorage.getItem('kicktv.added')).indexOf('alpha') !== -1, 'restore schedules a restart without replacing the running profile');
    window.dispatchEvent(new Event('pagehide'));
    assert(JSON.parse(localStorage.getItem(VOD_PROGRESS_KEY)).items['alpha:old'].position === 200, 'departing page saves only its old playback progress');
    assert(BackupRestore.recover().status === 'restored', 'next-boot recovery commits the imported profile');
    assert(localStorage.getItem(VOD_PROGRESS_KEY) === next['kicktv.vodprogress'], 'imported progress survives the old pagehide save');
    assert(localStorage.getItem('kicktv.added') === next['kicktv.added'], 'imported channels replace the old list together with progress');
    assert(BackupRestore.recover().status === 'none', 'later boots do not apply the restore again');
  } finally { window.setTimeout = timer; state.vod = null; delete video.currentTime; delete video.duration; }
};
