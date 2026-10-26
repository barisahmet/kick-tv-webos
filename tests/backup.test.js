const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function harness(store = new Map()) {
  let fail = () => false;
  const storage = {
    get length() { return store.size; }, key(i) { return Array.from(store.keys())[i]; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (fail('set', k, String(v))) throw Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem(k) { if (fail('remove', k)) throw Error('Storage unavailable'); store.delete(k); }
  };
  const h = { localStorage: storage, Date }; vm.createContext(h);
  const file = path.join(root, 'app/storage-restore.js');
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), h);
  return { h, store, storage, fail(fn) { fail = fn; } };
}
const original = { 'kicktv.added': '["original"]', 'kicktv.settings': '{"dim":true}', 'kicktv.vodprogress': '{"version":1,"items":{"old:1":{"position":100}}}' };
const incoming = { 'kicktv.added': '["imported"]', 'kicktv.settings': '{"dim":false}', 'kicktv.vodprogress': '{"version":1,"items":{"new:2":{"position":500}}}' };
function profile(store) { return Object.fromEntries([...store].filter(([k]) => k.startsWith('kicktv.'))); }
test('restore is staged until a new boot, so old pagehide writers cannot overwrite imported progress', () => {
  const a = harness(new Map(Object.entries(original)));
  a.h.BackupRestore.queue(incoming);
  assert.deepEqual(profile(a.store), original);
  a.storage.setItem('kicktv.vodprogress', '{"version":1,"items":{"old:1":{"position":200}}}');
  const b = harness(a.store);
  assert.equal(b.h.BackupRestore.recover().status, 'restored');
  assert.deepEqual(profile(b.store), incoming);
  assert.equal(b.h.BackupRestore.recover().status, 'none');
});
test('quota failure while staging or preparing recovery never changes active channels', () => {
  for (const key of ['kicktvbak.pendingrestore', 'kicktvbak.beforerestore']) {
    const a = harness(new Map(Object.entries(original)));
    a.fail((op, k) => op === 'set' && k === key);
    if (key.endsWith('pendingrestore')) assert.throws(() => a.h.BackupRestore.queue(incoming));
    else { a.h.BackupRestore.queue(incoming); assert.equal(a.h.BackupRestore.recover().status, 'rolledback'); }
    assert.deepEqual(profile(a.store), original);
  }
});
test('a write failure after removal rolls the entire profile back, including pins and progress', () => {
  const a = harness(new Map(Object.entries(original)));
  a.h.BackupRestore.queue(incoming);
  a.fail((op, k, value) => op === 'set' && k === 'kicktv.settings' && value === incoming[k]);
  assert.equal(a.h.BackupRestore.recover().status, 'rolledback');
  assert.deepEqual(profile(a.store), original);
  assert.equal(a.h.BackupRestore.recover().status, 'none');
});
test('interrupted apply and interrupted rollback recover before any app settings load', () => {
  for (const phase of ['applying', 'rollback']) {
    const a = harness(new Map([
      ['kicktv.added', '["partial"]'],
      ['kicktvbak.beforerestore', JSON.stringify({ app: 'com.barisahmet.kicktv', v: 1, storage: original })],
      ['kicktvbak.pendingrestore', JSON.stringify({ version: 1, phase, next: incoming })]
    ]));
    a.fail((op, k) => op === 'set' && k === 'kicktv.added');
    assert.equal(a.h.BackupRestore.recover().ok, false);
    assert(a.store.has('kicktvbak.pendingrestore'));
    const b = harness(a.store);
    assert.equal(b.h.BackupRestore.recover().status, 'rolledback');
    assert.deepEqual(profile(b.store), original);
  }
});
test('invalid restore data is refused and unrelated storage is preserved', () => {
  const a = harness(new Map(Object.entries(original).concat([['other-app', 'keep'], ['kicktv.channelcache', 'cache']])));
  for (const bad of [null, [], { 'kicktv.added': [] }]) assert.throws(() => a.h.BackupRestore.queue(bad));
  a.h.BackupRestore.queue(Object.assign({}, incoming, { 'other-app': 'replace', 'kicktv.channelcache': 'bad' }));
  assert.equal(a.h.BackupRestore.recover().ok, true);
  assert.equal(a.store.get('other-app'), 'keep');
  assert.equal(a.store.get('kicktv.channelcache'), 'cache');
});
test('pending restore cannot be replaced and damaged recovery records block startup', () => {
  const a = harness(); a.h.BackupRestore.queue(incoming);
  assert.throws(() => a.h.BackupRestore.queue(original));
  a.store.set('kicktvbak.pendingrestore', '{broken');
  assert.equal(a.h.BackupRestore.recover().ok, false);
  assert.equal(a.store.get('kicktvbak.pendingrestore'), '{broken');
});

test('failed recovery blocks boot and background refresh before they read partial data', () => {
  const callbacks = {}, calls = [], node = {};
  const h = {
    BackupRestore: { recover: () => ({ ok: false }) },
    document: { addEventListener: (name, fn) => { callbacks[name] = fn; }, getElementById: () => node },
    window: { addEventListener: (name, fn) => { callbacks[name] = fn; } },
    showState: () => {}, setMode: () => calls.push('mode'), loadSettings: () => calls.push('settings'),
    fetchFavorites: () => calls.push('fetch')
  };
  vm.createContext(h); vm.runInContext(fs.readFileSync(path.join(root, 'app/app.js'), 'utf8'), h);
  callbacks.visibilitychange(); callbacks.online();
  assert.deepEqual(calls, []);
  assert.match(node.textContent, /Restart/);
});
