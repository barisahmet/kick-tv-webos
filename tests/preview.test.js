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
