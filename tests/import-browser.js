window.runImportTests = function (assert) {
  var realApi = serviceGet, realFetch = fetchFavorites, realLuna = lunaCall, requests = [];
  serviceGet = function (path, cb) { var slug = path.split('/').pop(); var r = { slug: slug, cb: cb }; requests.push(r); return { cancel: function () { r.cancelled = true; } }; };
  fetchFavorites = function (cb) { cb(); }; lunaCall = function () {};
  function raw(slug) { return { slug: slug, user: { username: slug }, livestream: null }; }
  try {
    backup.open = true;
    addBackupNames(['new-one', 'new-two']);
    backupKey(KEY.BACK);
    requests[0].cb(null, raw('new-one'));
    assert(!isFavorite('new-one') && requests.length === 1, 'cancel stops in-flight callbacks from adding channels or starting more work');
    assert(backup.open && !backup.busy, 'Back cancels import while keeping the result visible');
    addBackupNames(['new-one', 'absent', 'retry-me']);
    requests[1].cb(null, raw('new-one'));
    requests[2].cb(404);
    requests[3].cb('timeout');
    var status = document.getElementById('backup-status').textContent;
    assert(isFavorite('new-one') && !isFavorite('retry-me'), 'only confirmed channels are added');
    assert(status.indexOf('absent') !== -1 && /could not check/i.test(status), 'missing channels and connectivity failures have separate results');
    assert(!document.getElementById('backup-retry').classList.contains('hidden'), 'failed lookups offer a visible retry action');
    backupKey(KEY.OK);
    assert(requests[4].slug === 'retry-me', 'retry repeats only failed lookups, not successful or missing channels');
    requests[4].cb(null, raw('retry-me'));
    assert(isFavorite('retry-me') && !backup.busy, 'retry finishes and persists the recovered channel');
    addBackupNames(['late-channel']); var late = requests[5];
    closeBackup(); backup.open = true; addBackupNames(['fresh-channel']);
    late.cb(null, raw('late-channel'));
    assert(!isFavorite('late-channel') && requests.length === 7, 'closing and reopening cannot let the old import change the new session');
    requests[6].cb(null, raw('fresh-channel'));
  } finally { closeBackup(); serviceGet = realApi; fetchFavorites = realFetch; lunaCall = realLuna; }
};
