'use strict';
/* Backup and restore through a phone, opened from the Settings row. The service
   serves a page on the home network while this popup is open; the TV shows its
   address as a QR code. Whatever the phone sends back waits here until it is
   confirmed on the TV. */
var BACKUP_POLL_MS = 2000;
// Machine-local or big, and rebuilt on their own: not worth carrying to another TV.
var BACKUP_SKIP_KEYS = { 'kicktv.channelcache': true, 'kicktv.lastplay': true };
var backup = { open: false, token: '', timer: null, url: '', inbox: null, choice: 0, choices: [], busy: false, starting: false, importJob: null, retryNames: [] };

function lunaCall(method, params, cb) {
  var Bridge = window.WebOSServiceBridge || window.PalmServiceBridge;
  if (!Bridge) { cb('nobridge'); return; }
  var bridge, done = false;
  try { bridge = new Bridge(); } catch (e) { cb('nobridge'); return; }
  var timer = setTimeout(function () { if (!done) { done = true; cb('timeout'); } }, 8000);
  bridge.onservicecallback = function (msg) {
    if (done) return;
    done = true; clearTimeout(timer);
    var r = null;
    try { r = JSON.parse(msg); } catch (e) {}
    if (r && r.ok) cb(null, r); else cb((r && r.error) || 'service');
  };
  try { bridge.call('luna://com.barisahmet.kicktv.service/' + method, JSON.stringify(params || {})); }
  catch (e) { if (!done) { done = true; clearTimeout(timer); cb('callfail'); } }
}
function backupToken() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', out = '';
  var bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  for (var i = 0; i < bytes.length; i++) out += chars.charAt(bytes[i] % chars.length);
  return out;
}
function backupSnapshot() {
  var storage = {};
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('kicktv.') === 0 && !BACKUP_SKIP_KEYS[k] && !/\.corrupt$/.test(k)) storage[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  var favs = getFavorites();
  return { app: 'com.barisahmet.kicktv', v: 1, at: new Date().toISOString(),
           channels: favs.map(function (s) { return (state.channels[s] && state.channels[s].name) || s; }),
           storage: storage };
}

function openBackup() {
  cancelBackupImport();
  backup.importJob = null; backup.retryNames = [];
  updateBackupImportButtons();
  backup.open = true;
  backup.token = backupToken();
  backup.inbox = null; backup.url = ''; backup.busy = false;
  // the Settings row's description balloon would sit over the QR code
  clearTimeout(settingDescTimer);
  document.getElementById('settings-desc').className = 'hidden';
  document.getElementById('backupmodal').className = '';
  document.getElementById('backup-ask').className = 'hidden';
  document.getElementById('backup-main').className = '';
  drawBackupQr('');
  setBackupStatus('Starting...');
  startBackupShare();
  clearInterval(backup.timer);
  backup.timer = setInterval(pollBackup, BACKUP_POLL_MS);
  touchSettings();
}
function closeBackup() {
  cancelBackupImport();
  backup.open = false;
  clearInterval(backup.timer); backup.timer = null;
  document.getElementById('backupmodal').className = 'hidden';
  lunaCall('shareStop', {}, function () {});
  if (settings.open) { renderSettings(); touchSettings(); }     // brings the row's description back
}
function startBackupShare() {
  if (backup.starting) return;
  backup.starting = true;
  var snap = backupSnapshot(), tok = backup.token;
  lunaCall('shareStart', { token: tok, backup: JSON.stringify(snap, null, 1), names: snap.channels }, function (err, r) {
    backup.starting = false;
    if (!backup.open || backup.token !== tok) return;
    if (err || !r.addresses || !r.addresses.length) {
      setBackupStatus(err ? 'Could not start the backup page (' + err + ').' : 'The TV is not on a network.');
      return;
    }
    backup.url = 'http://' + r.addresses[0] + ':' + r.port + '/' + tok + '/';
    drawBackupQr(backup.url);
    document.getElementById('backup-url').textContent = backup.url.replace(/^http:\/\//, '');
    setBackupStatus('Waiting for your phone...');
  });
}
function pollBackup() {
  if (!backup.open || backup.busy) return;
  var token = backup.token;
  lunaCall('sharePoll', { token: token }, function (err, r) {
    if (!backup.open || backup.busy || token !== backup.token || err) return;
    // the service can be restarted under us; bring the same address back up
    if (!r.running) { startBackupShare(); return; }
    if (r.visits && !backup.inbox && !backup.importJob) setBackupStatus('Phone connected.');
    if (r.inbox) receiveBackupInbox(r.inbox);
  });
}
function setBackupStatus(t) { document.getElementById('backup-status').textContent = t; }
function drawBackupQr(text) {
  var cv = document.getElementById('backup-qr'), ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!text || typeof qrcode !== 'function') return;
  var qr = qrcode(0, 'M');
  qr.addData(text); qr.make();
  var n = qr.getModuleCount(), quiet = 3;
  var cell = Math.floor(cv.width / (n + quiet * 2)), off = Math.floor((cv.width - cell * n) / 2);
  ctx.fillStyle = '#000';
  for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
    if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
  }
}

// Normalise what the phone typed into channel slugs: names or kick.com links.
function backupSlugs(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (raw) {
    var s = String(raw || '').trim().toLowerCase()
      .replace(/^https?:\/\/(www\.)?kick\.com\//, '').replace(/[\/?#].*$/, '');
    if (/^[a-z0-9_-]{1,40}$/.test(s) && out.indexOf(s) === -1) out.push(s);
  });
  return out.slice(0, 200);
}
function backupFavsOf(storage) {
  var added = [], removed = [];
  try { added = JSON.parse(storage['kicktv.added'] || '[]') || []; } catch (e) {}
  try { removed = JSON.parse(storage['kicktv.removed'] || '[]') || []; } catch (e) {}
  if (!Array.isArray(added)) added = [];
  if (!Array.isArray(removed)) removed = [];
  var favs = SEED_FAVORITES.concat(added).filter(function (s, i, a) {
    return typeof s === 'string' && a.indexOf(s) === i && removed.indexOf(s) === -1;
  });
  return favs;
}
function receiveBackupInbox(inbox) {
  if (backup.busy) return;
  backup.importJob = null; backup.retryNames = []; updateBackupImportButtons();
  var q, choices;
  if (inbox.kind === 'backup') {
    var d = inbox.data;
    if (!d || d.app !== 'com.barisahmet.kicktv' || !d.storage || typeof d.storage !== 'object') {
      setBackupStatus('That file is not a Kick TV backup.'); return;
    }
    var n = backupFavsOf(d.storage).length;
    q = 'Restore the backup' + (d.at ? ' from ' + String(d.at).slice(0, 10) : '') + ' with ' + n + ' channel' + (n === 1 ? '' : 's') + '?';
    choices = [{ label: 'Replace everything', act: 'replace' }, { label: 'Add its channels', act: 'merge' }, { label: 'Ignore', act: 'ignore' }];
  } else {
    var slugs = backupSlugs(inbox.data).filter(function (s) { return !isFavorite(s); });
    if (!slugs.length) { setBackupStatus('Nothing new to add.'); return; }
    inbox.slugs = slugs;
    q = 'Add ' + slugs.length + ' channel' + (slugs.length === 1 ? '' : 's') + ': ' + slugs.slice(0, 6).join(', ') + (slugs.length > 6 ? ', ...' : '') + '?';
    choices = [{ label: 'Add', act: 'names' }, { label: 'Ignore', act: 'ignore' }];
  }
  backup.inbox = inbox; backup.choices = choices; backup.choice = 0;
  document.getElementById('backup-question').textContent = q;
  document.getElementById('backup-main').className = 'hidden';
  document.getElementById('backup-ask').className = '';
  renderBackupChoices();
}
function renderBackupChoices() {
  var box = document.getElementById('backup-choices');
  box.innerHTML = '';
  backup.choices.forEach(function (c, i) {
    var b = document.createElement('div');
    b.className = 'backup-choice' + (i === backup.choice ? ' focused' : '');
    b.setAttribute('data-idx', i);
    b.textContent = c.label;
    box.appendChild(b);
  });
}
function backupChoiceMove(d) {
  var n = backup.choice + d;
  if (n < 0 || n >= backup.choices.length) return;
  backup.choice = n; renderBackupChoices();
}
function backupAskDone(status) {
  backup.inbox = null;
  document.getElementById('backup-ask').className = 'hidden';
  document.getElementById('backup-main').className = '';
  if (status) setBackupStatus(status);
}
function backupChoose() {
  var c = backup.choices[backup.choice], inbox = backup.inbox;
  if (!c || !inbox) return;
  if (c.act === 'ignore') { backupAskDone('Ignored. Waiting for your phone...'); return; }
  if (c.act === 'replace') { applyBackupReplace(inbox.data.storage); return; }
  if (c.act === 'merge') {
    var favs = backupFavsOf(inbox.data.storage), pins = [];
    try { pins = JSON.parse(inbox.data.storage['kicktv.pinned'] || '[]') || []; } catch (e) {}
    var added = 0;
    favs.forEach(function (s) { if (!isFavorite(s)) { addFavorite(s); added++; } });
    if (Array.isArray(pins)) pins.forEach(function (s) { if (isFavorite(s) && !isPinned(s)) togglePin(s); });
    backupAskDone('Added ' + added + ' channel' + (added === 1 ? '' : 's') + '.');
    fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(); });
    return;
  }
  if (c.act === 'names') addBackupNames(inbox.slugs);
}
// Check each name with Kick first, so a typo does not become a dead row.
function updateBackupImportButtons() {
  document.getElementById('backup-cancel').className = backup.busy ? 'backup-choice focused' : 'hidden';
  document.getElementById('backup-retry').className = !backup.busy && backup.retryNames.length ? 'backup-choice focused' : 'hidden';
}
function finishBackupImport(job, cancelled) {
  backup.busy = false; backup.inbox = null; job.cancel = null;
  backup.retryNames = job.failed.concat(cancelled ? job.slugs.slice(job.index) : []);
  setBackupStatus((cancelled ? 'Stopped. ' : '') + 'Added ' + job.added.length + '.' +
    (job.missing.length ? ' Not found: ' + job.missing.join(', ') + '.' : '') +
    (job.failed.length ? ' Could not check: ' + job.failed.join(', ') + '.' : '') +
    (backup.retryNames.length ? ' Retry ' + backup.retryNames.length + ' remaining.' : ''));
  updateBackupImportButtons();
  if (job.added.length) fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(); });
}
function cancelBackupImport() {
  var job = backup.importJob;
  if (!job || !backup.busy) return;
  job.stopped = true;
  if (job.cancel) {
    if (typeof job.cancel === 'function') job.cancel();
    else if (job.cancel.cancel) job.cancel.cancel();
  }
  finishBackupImport(job, true);
}
function retryBackupImport() { if (!backup.busy && backup.retryNames.length) addBackupNames(backup.retryNames.slice()); }
function addBackupNames(slugs) {
  cancelBackupImport();
  var job = { slugs: slugs.filter(function (s) { return !isFavorite(s); }), index: 0,
    added: [], missing: [], failed: [], stopped: false, cancel: null };
  backup.importJob = job; backup.retryNames = []; backup.busy = true;
  updateBackupImportButtons();
  document.getElementById('backup-ask').className = 'hidden';
  document.getElementById('backup-main').className = '';
  function next() {
    if (job.stopped || backup.importJob !== job || !backup.open) return;
    if (job.index >= job.slugs.length) { finishBackupImport(job, false); return; }
    var slug = job.slugs[job.index], index = job.index;
    setBackupStatus('Checking ' + slug + '... (' + (index + 1) + ' of ' + job.slugs.length + ')');
    var request = serviceGet('/api/v2/channels/' + encodeURIComponent(slug), function (err, data) {
      if (job.stopped || backup.importJob !== job || !backup.open) return;
      job.cancel = null;
      if (err === 404) job.missing.push(slug);
      else if (err || !data || typeof data !== 'object' || !data.user) job.failed.push(slug);
      else { state.channels[slug] = normalize(slug, data); addFavorite(slug); job.added.push(slug); }
      job.index++; next();
    }, { priority: 1 });
    if (job.index === index && !job.stopped) job.cancel = request;
  }
  next();
}
function applyBackupReplace(storage) {
  try {
    BackupRestore.queue(storage);
  } catch (e) {
    backupAskDone('Could not restore: ' + (e && e.message || e)); return;
  }
  closeBackup();
  toast('Restarting to restore your backup...');
  // The next boot applies the backup after this page's final progress save.
  setTimeout(function () { location.reload(); }, 800);
}
function backupKey(k) {
  if (backup.busy) { if (k === KEY.BACK || k === KEY.OK) cancelBackupImport(); return; }
  if (!backup.inbox && backup.retryNames.length && k === KEY.OK) { retryBackupImport(); return; }
  if (backup.inbox && !backup.busy) {
    if (k === KEY.LEFT || k === KEY.UP) backupChoiceMove(-1);
    else if (k === KEY.RIGHT || k === KEY.DOWN) backupChoiceMove(1);
    else if (k === KEY.OK) backupChoose();
    else if (k === KEY.BACK) backupAskDone('Ignored. Waiting for your phone...');
    return;
  }
  if (k === KEY.BACK || k === KEY.OK) closeBackup();
}
