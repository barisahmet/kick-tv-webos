'use strict';
/* Backup and restore through a phone, opened from the Settings row. The service
   serves a page on the home network while this popup is open; the TV shows its
   address as a QR code. Whatever the phone sends back waits here until it is
   confirmed on the TV. */
var BACKUP_POLL_MS = 2000;
// Machine-local or big, and rebuilt on their own: not worth carrying to another TV.
var BACKUP_SKIP_KEYS = { 'kicktv.channelcache': true, 'kicktv.lastplay': true };
var backup = { open: false, token: '', timer: null, url: '', inbox: null, choice: 0, choices: [], busy: false, starting: false };

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
  backup.open = false;
  clearInterval(backup.timer); backup.timer = null;
  document.getElementById('backupmodal').className = 'hidden';
  lunaCall('shareStop', {}, function () {});
  if (settings.open) renderSettings();     // brings the row's description back
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
  lunaCall('sharePoll', { token: backup.token }, function (err, r) {
    if (!backup.open || err) return;
    // the service can be restarted under us; bring the same address back up
    if (!r.running) { startBackupShare(); return; }
    if (r.visits && !backup.inbox) setBackupStatus('Phone connected.');
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
function addBackupNames(slugs) {
  backup.busy = true;
  document.getElementById('backup-ask').className = 'hidden';
  document.getElementById('backup-main').className = '';
  var added = [], missing = [], i = 0;
  function next() {
    if (i >= slugs.length) {
      backup.busy = false; backup.inbox = null;
      setBackupStatus('Added ' + added.length + (missing.length ? '. Not found: ' + missing.join(', ') : '') + '.');
      fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(); });
      return;
    }
    var slug = slugs[i++];
    setBackupStatus('Checking ' + slug + '... (' + i + ' of ' + slugs.length + ')');
    apiGet(slug, function (err, data) {
      if (err) missing.push(slug);
      else { state.channels[slug] = normalize(slug, data); addFavorite(slug); added.push(slug); }
      next();
    });
  }
  next();
}
function applyBackupReplace(storage) {
  try {
    // keep what is being replaced, once, outside the kicktv.* space the backup covers
    localStorage.setItem('kicktvbak.beforerestore', JSON.stringify(backupSnapshot()));
    var drop = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('kicktv.') === 0 && !BACKUP_SKIP_KEYS[k]) drop.push(k);
    }
    drop.forEach(function (k) { localStorage.removeItem(k); });
    Object.keys(storage).forEach(function (k) {
      if (k.indexOf('kicktv.') === 0 && !BACKUP_SKIP_KEYS[k] && typeof storage[k] === 'string') localStorage.setItem(k, storage[k]);
    });
  } catch (e) {
    backupAskDone('Could not restore: ' + (e && e.message || e)); return;
  }
  closeBackup();
  toast('Restored. Restarting...');
  // every module reads its settings at startup, so start fresh on the restored data
  setTimeout(function () { location.reload(); }, 800);
}
function backupKey(k) {
  if (backup.inbox && !backup.busy) {
    if (k === KEY.LEFT || k === KEY.UP) backupChoiceMove(-1);
    else if (k === KEY.RIGHT || k === KEY.DOWN) backupChoiceMove(1);
    else if (k === KEY.OK) backupChoose();
    else if (k === KEY.BACK) backupAskDone('Ignored. Waiting for your phone...');
    return;
  }
  if (k === KEY.BACK || k === KEY.OK) closeBackup();
}
