/* Restore is staged while playback runs, then applied before the next boot
   reads any settings. The old page's pagehide/timers only touch the old profile.
   A durable journal keeps an interrupted replacement recoverable. ES5 for TV. */
var BackupRestore = (function () {
  var PENDING = 'kicktvbak.pendingrestore', BEFORE = 'kicktvbak.beforerestore';
  function managed(key) {
    return key.indexOf('kicktv.') === 0 && key !== 'kicktv.channelcache' && key !== 'kicktv.lastplay';
  }
  function profile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid backup data');
    var out = Object.create(null);
    Object.keys(value).forEach(function (key) {
      if (!managed(key)) return;
      if (typeof value[key] !== 'string') throw new Error('Invalid backup value');
      out[key] = value[key];
    });
    return out;
  }
  function snapshot() {
    var out = Object.create(null);
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && managed(key)) out[key] = localStorage.getItem(key);
    }
    return out;
  }
  function replace(value) {
    Object.keys(snapshot()).forEach(function (key) { localStorage.removeItem(key); });
    Object.keys(value).forEach(function (key) { localStorage.setItem(key, value[key]); });
  }
  function queue(value) {
    var next = profile(value);
    if (localStorage.getItem(PENDING) !== null) throw new Error('A restore is already pending');
    // setItem is atomic: quota failure here leaves all current data untouched.
    localStorage.setItem(PENDING, JSON.stringify({ version: 1, phase: 'pending', next: next }));
  }
  function rollback() {
    var saved = JSON.parse(localStorage.getItem(BEFORE));
    if (!saved || saved.app !== 'com.barisahmet.kicktv' || saved.v !== 1) throw new Error('Missing recovery backup');
    var previous = profile(saved.storage);
    // Release the staged payload's space before rewriting the old profile.
    // If this fails, the existing 'applying' journal still requests rollback.
    try { localStorage.setItem(PENDING, JSON.stringify({ version: 1, phase: 'rollback' })); } catch (e) {}
    replace(previous);
    localStorage.removeItem(PENDING);
    return { ok: true, status: 'rolledback' };
  }
  function recover() {
    try {
      var raw = localStorage.getItem(PENDING);
      if (raw === null) return { ok: true, status: 'none' };
      var journal = JSON.parse(raw);
      if (!journal || journal.version !== 1) throw new Error('Invalid recovery record');
      if (journal.phase === 'applying' || journal.phase === 'rollback') return rollback();
      if (journal.phase !== 'pending') throw new Error('Invalid recovery phase');
      var next = profile(journal.next);
      try {
        // Do not delete anything until both the backup and intent are durable.
        localStorage.setItem(BEFORE, JSON.stringify({ app: 'com.barisahmet.kicktv', v: 1,
          at: new Date().toISOString(), storage: snapshot() }));
        localStorage.setItem(PENDING, JSON.stringify({ version: 1, phase: 'applying' }));
      } catch (e) {
        localStorage.removeItem(PENDING);
        return { ok: true, status: 'rolledback' }; // no active key has changed
      }
      try {
        replace(next);
        localStorage.removeItem(PENDING); // commit; a crash before this rolls back
        return { ok: true, status: 'restored' };
      } catch (e) { return rollback(); }
    } catch (e) {
      // Keep the journal and stop boot: loading a partial profile would let
      // background writers destroy the only recoverable state.
      return { ok: false, status: 'blocked' };
    }
  }
  return { queue: queue, recover: recover };
})();
