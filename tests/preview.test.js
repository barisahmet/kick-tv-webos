const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture(bitmap) {
  let now = 0, id = 0;
  const timers = new Map(), images = [], requests = [];
  const h = { console, logError() {}, pickSrcsetUrl() { return null; }, setInterval() {}, document: { getElementById: () => ({ addEventListener() {} }) },
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimeout(i) { timers.delete(i); },
    Image: function () { images.push(this); },
    XMLHttpRequest: function () { requests.push(this); this.open = this.send = () => {}; this.abort = () => { this.aborted = true; }; }
  };
  h.window = { addEventListener() {}, createImageBitmap: bitmap };
  h.createImageBitmap = bitmap;
  vm.createContext(h); vm.runInContext(fs.readFileSync('app/js/sidebar.js', 'utf8'), h);
  h.previewTargetSize = () => ({ w: 20, h: 10 });
  return { h, images, requests, advance(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([,t]) => t.at <= until).sort((a,b) => a[1].at-b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = until;
  } };
}
test('a hung image fallback settles and releases the channel for another preview request', () => {
  const f = fixture(); let completed = 0;
  f.h.serviceGet = (path, cb) => cb(null, { livestream: { thumbnail: { url: 'frame' } } });
  f.h.fetchPreviewUrl('alpha', () => completed++);
  const late = f.images[0].onload;
  f.advance(3000);
  assert.equal(completed, 1);
  assert.equal(f.h.previewPending.alpha, undefined);
  late(); assert.equal(completed, 1);
  assert(!f.h.previewCache.alpha || !f.h.previewCache.alpha.ready);
  f.h.fetchPreviewUrl('alpha', () => completed++);
  f.images[1].onload();
  assert.equal(completed, 2);
  assert.equal(f.h.previewCache.alpha.ready, true);
});
test('a stuck decoder cannot block the next frame and late bitmaps are released', async () => {
  let resolve; const f = fixture(() => new Promise(r => { resolve = r; }));
  let first = 0, second = 0, closed = 0;
  f.h.loadPreviewFrame('one', () => first++);
  Object.assign(f.requests[0], { status: 200, response: {} }); f.requests[0].onload();
  f.advance(3000);
  assert.equal(first, 1);
  resolve({ close() { closed++; } }); await Promise.resolve();
  assert.equal(closed, 1);
  f.h.createImageBitmap = () => Promise.resolve({ width: 20, height: 10 });
  f.h.scalePreviewBitmap = x => x;
  f.h.loadPreviewFrame('two', bitmap => { if (bitmap) second++; });
  Object.assign(f.requests[1], { status: 200, response: {} }); f.requests[1].onload();
  f.advance(50); // preparation queue yields between frames
  await Promise.resolve();
  assert.equal(second, 1);
  assert.equal(first, 1);
});

test('the three-second preview budget includes metadata lookup and ignores its late response', () => {
  const f = fixture(); let reply, completed = 0, cancelled = 0;
  f.h.serviceGet = (path, cb) => { reply = cb; return { cancel() { cancelled++; } }; };
  f.h.fetchPreviewUrl('alpha', () => completed++);
  f.advance(3000);
  assert.equal(completed, 1);
  assert.equal(cancelled, 1);
  reply(null, { livestream: { thumbnail: { url: 'late' } } });
  assert.equal(f.images.length, 0);
  assert.equal(f.h.previewPending.alpha, undefined);
});
test('a slow metadata reply leaves only the remaining budget for the image', () => {
  const f = fixture(); let reply, completed = 0;
  f.h.serviceGet = (path, cb) => { reply = cb; };
  f.h.previewCache.alpha = { ready: true, url: 'previous', t: 0 };
  f.h.fetchPreviewUrl('alpha', () => completed++);
  f.advance(2500);
  reply(null, { livestream: { thumbnail: { url: 'new' } } });
  const late = f.images[0].onload;
  f.advance(500);
  assert.equal(completed, 1);
  assert.equal(f.h.previewCache.alpha.url, 'previous');
  late();
  assert.equal(completed, 1);
  assert.equal(f.h.previewCache.alpha.url, 'previous');
});

// The background warmer. Lookups run one at a time behind everything else, so
// starting every channel's three-second budget at once left the later ones no time.
function warmFixture() {
  const f = fixture(), asked = [], replies = [];
  const slugs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  f.h.state = { ready: true, order: slugs, tempChannel: null, sidebarOpen: false, sideItems: [], sideFocus: 0,
    channels: Object.fromEntries(slugs.map(s => [s, { live: true }])) };
  f.h.saver = { on: false };
  f.h.serviceGet = (path, cb) => { asked.push(path.split('/').pop()); replies.push(cb); return { cancel() {} }; };
  return { f, asked, replies, slugs };
}
test('warming gives every live channel its own three seconds, one after another', () => {
  const { f, asked, replies, slugs } = warmFixture();
  f.h.warmPreviews(true);
  assert.deepEqual(asked, ['a'], 'one lookup at a time');
  // 0.7s a lookup: eight of them take 5.6s, far past any one channel's budget.
  for (let i = 0; i < 8; i++) { f.advance(700); replies[i](null, { livestream: { thumbnail: null } }); }
  assert.deepEqual(asked, slugs, 'and the last channel is still reached');
});
test('a lookup that never answers gives up after its three seconds and the next channel gets its turn', () => {
  const { f, asked } = warmFixture();
  f.h.warmPreviews(true);
  f.advance(2999);
  assert.deepEqual(asked, ['a']);
  f.advance(1);
  assert.deepEqual(asked, ['a', 'b']);
});
test('a second warm pass while one is under way does not double up', () => {
  const { f, asked, replies } = warmFixture();
  f.h.warmPreviews(true);
  f.h.warmPreviews(true);
  assert.deepEqual(asked, ['a']);
  replies[0](null, { livestream: { thumbnail: null } });
  assert.deepEqual(asked, ['a', 'b']);
});
