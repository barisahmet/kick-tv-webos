const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app/ui-runtime.js'), 'utf8');

function harness() {
  let now = 1000, nextTimer = 1;
  const timers = new Map(), startedImages = [], events = {};
  function timeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, at: now + (delay || 0) }); return id; }
  function tick(ms = 0) {
    const end = now + ms;
    let turns = 0;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      assert.ok(turns++ < 10000, 'timer loop stays bounded');
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end;
  }
  function element(tag = 'div', top = 10) {
    const attrs = {};
    return {
      tagName: tag.toUpperCase(), className: '', style: {}, children: [], parentNode: null,
      rect: { top, bottom: top + 60, left: 10, right: 110, width: 100, height: 60 },
      setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
      removeAttribute(k) { delete attrs[k]; if (k === 'src') this.src = ''; },
      appendChild(child) { this.children.push(child); child.parentNode = this; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
      contains(child) { return this === child || this.children.some(c => c.contains(child)); },
      getBoundingClientRect() { return this.rect; },
      querySelectorAll() {
        const found = [];
        function walk(node) { for (const child of node.children) { if (child.getAttribute('data-ui-src') || child.getAttribute('data-src')) found.push(child); walk(child); } }
        walk(this); return found;
      }
    };
  }
  const root = element('html');
  class FakeImage {
    set src(value) { this.url = value; if (value) startedImages.push(this); }
    get src() { return this.url; }
  }
  const context = {
    Date: class extends Date { static now() { return now; } },
    setTimeout: timeout, clearTimeout: id => timers.delete(id),
    Image: FakeImage, innerWidth: 1920, innerHeight: 1080,
    document: { documentElement: root, createElement: element, querySelectorAll: () => root.querySelectorAll() },
    addEventListener(name, callback) { events[name] = callback; }
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(source, context);
  return { ...context, tick, element, root, startedImages,
    dispatch(name, target) { if (events[name]) events[name]({ target }); } };
}

test('priorities start playback first and reserve capacity from background work', () => {
  const h = harness(), calls = [];
  h.UIWork.setTransport((p, cb, opts) => { calls.push({ p, cb, opts }); });
  for (let i = 0; i < 5; i++) h.UIWork.request('/background/' + i, () => {}, { priority: 2 });
  h.UIWork.request('/active', () => {}, { priority: 1 });
  h.UIWork.request('/playback', () => {}, { priority: 0 });
  h.tick();
  assert.deepEqual(calls.map(c => c.p), ['/playback', '/active', '/background/0', '/background/1']);
  assert.equal(h.UIWork.stats().active, 4);
  calls[0].cb(null, {}); h.tick();
  assert.equal(calls.length, 4, 'background cannot consume more than two slots');
  h.UIWork.request('/next-playback', () => {}, { priority: 0 }); h.tick();
  assert.equal(calls[4].p, '/next-playback');

});

test('deduplicates, promotes queued work, and isolates throwing callbacks', () => {
  const h = harness(), calls = [], answers = [];
  h.UIWork.setTransport((p, cb, opts) => { calls.push({ p, cb, opts }); });
  h.UIWork.request('/same', () => { throw Error('callback'); }, { priority: 2, compact: true });
  h.UIWork.request('/same', (err, data) => answers.push(data), { priority: 0, compact: true });
  h.UIWork.request('/same', () => {}, { compact: false });
  h.tick();
  assert.equal(calls.length, 2, 'raw and compact callers have separate responses');
  assert.equal(calls[0].opts.priority, 0);
  calls[0].cb(null, 'ok'); calls[0].cb(null, 'duplicate'); h.tick();
  assert.deepEqual(answers, ['ok']);
});

test('listener cancellation preserves other subscribers and aborts only the last', () => {
  const h = harness(), calls = [], answers = [];
  let aborted = 0;
  h.UIWork.setTransport((p, cb) => { calls.push({ p, cb }); return { abort() { aborted++; cb('aborted'); } }; });
  const first = h.UIWork.request('/same', () => answers.push('first'));
  h.UIWork.request('/same', () => answers.push('second'));
  h.tick(); first.cancel();
  assert.equal(aborted, 0);
  calls[0].cb(null, 'ok'); h.tick(); assert.deepEqual(answers, ['second']);
  const last = h.UIWork.request('/cancel', () => answers.push('cancel')); h.tick(); last.cancel(); h.tick();
  assert.equal(aborted, 1); assert.equal(h.UIWork.stats().active, 0);
  calls[1].cb(null, 'late'); h.tick(); assert.deepEqual(answers, ['second']);
  const pending = h.UIWork.request('/never-start', () => answers.push('pending')); pending.cancel(); h.tick();
  assert.equal(calls.length, 2);
});

test('queue bounds displace background work for playback and failures release slots', () => {
  const h = harness(), errors = [];
  for (let i = 0; i < 96; i++) h.UIWork.request('/bg/' + i, err => errors.push(err), { priority: 2 });
  h.UIWork.request('/play', () => {}, { priority: 0 });
  h.UIWork.request('/overflow', err => errors.push(err), { priority: 2 }); h.tick();
  assert.equal(h.UIWork.stats().queued, 96); assert.deepEqual(errors, ['busy', 'busy']);
  const first = [];
  h.UIWork.setTransport((p, cb) => { first.push(p); if (p === '/play') throw Error('transport failed'); cb('network'); }); h.tick();
  assert.equal(first[0], '/play'); assert.equal(h.UIWork.stats().active, 0); assert.equal(h.UIWork.stats().queued, 0);
});

test('transport watchdog cancels hung work and late replies stay ignored', () => {
  const h = harness(), replies = [];
  let done, aborted = 0;
  h.UIWork.setTransport((p, cb) => { done = cb; return () => aborted++; });
  h.UIWork.request('/hung', err => replies.push(err)); h.tick(); h.tick(15000);
  assert.deepEqual(replies, ['timeout']); assert.equal(aborted, 1); assert.equal(h.UIWork.stats().active, 0);
  done(null, 'late'); h.tick(); assert.equal(replies.length, 1);
});

test('cache hits are asynchronous, deduplicated, expiring, and evict least recently used entries', () => {
  const h = harness(), replies = [];
  let complete, loads = 0;
  function loader(cb) { loads++; complete = cb; }
  h.UIWork.cached('shared', loader, (err, data) => replies.push(data), 100);
  h.UIWork.cached('shared', loader, (err, data) => replies.push(data), 100);
  assert.equal(loads, 1); complete(null, { id: 7 }); h.tick(); assert.equal(replies.length, 2);
  h.UIWork.cached('shared', loader, () => replies.push('hit'), 100);
  assert.equal(replies.length, 2); h.tick(); assert.equal(replies[2], 'hit');
  h.tick(101); h.UIWork.cached('shared', loader, () => {}); assert.equal(loads, 2); complete('network'); h.tick();
  h.UIWork.clearCache();
  for (let i = 0; i < 64; i++) h.UIWork.cached(String(i), cb => cb(null, i), () => {});
  h.UIWork.cached('0', () => assert.fail('hot entry should be cached'), () => {});
  h.UIWork.cached('64', cb => cb(null, 64), () => {}); h.tick();
  assert.equal(h.UIWork.stats().cacheEntries, 64);
  let missed = 0;
  h.UIWork.cached('1', cb => { missed++; cb(null, 1); }, () => {}); h.tick();
  assert.equal(missed, 1, 'entry 1 was least recently read');
});

test('cache bounds bytes, ignores errors and oversize values, and cancels loaders safely', () => {
  const h = harness();
  let loads = 0, aborted = 0, done, called = 0;
  const item = 'x'.repeat(100000);
  for (let i = 0; i < 30; i++) h.UIWork.cached('large-' + i, cb => cb(null, item), () => {});
  assert.ok(h.UIWork.stats().cacheBytes <= 2097152); assert.equal(h.UIWork.stats().cacheEntries, 10);
  h.UIWork.clearCache();
  function failed(cb) { loads++; cb('network'); }
  h.UIWork.cached('error', failed, () => {}); h.UIWork.cached('error', failed, () => {}); assert.equal(loads, 2);
  h.UIWork.cached('too-large', cb => cb(null, 'x'.repeat(140000)), () => {}); assert.equal(h.UIWork.stats().cacheEntries, 0);
  const handle = h.UIWork.cached('cancel', cb => { done = cb; return { cancel() { aborted++; } }; }, () => called++);
  handle.cancel(); done(null, 'late'); h.tick();
  assert.equal(aborted, 1); assert.equal(called, 0); assert.equal(h.UIWork.stats().cacheEntries, 0);
  h.UIWork.cached('__proto__', cb => cb(null, 5), () => called++); h.tick(); assert.equal(called, 1);
});

test('artwork starts only nearby, maintains concurrency, and shows fallback on failure', () => {
  const h = harness(), nodes = [];
  for (let i = 0; i < 7; i++) { const el = h.element('div', i === 6 ? 3000 : 20); h.root.appendChild(el); nodes.push(el); h.UIImages.watch(el, '/image/' + i, 'Channel'); }
  h.tick(16); assert.equal(h.startedImages.length, 4); assert.equal(h.UIImages.stats().active, 4);
  h.startedImages[0].onerror(); h.tick(16);
  assert.equal(nodes[0].getAttribute('data-ui-image-state'), 'error'); assert.equal(nodes[0].children[0].textContent, 'C');
  assert.equal(h.startedImages.length, 5);
  h.startedImages[1].onload(); h.tick(16); assert.equal(h.startedImages.length, 6);
  h.startedImages[2].onload(); h.tick(16); assert.equal(h.startedImages.length, 6, 'distant image stays unrequested');
  nodes[6].rect = { top: 20, bottom: 80, left: 0, right: 100, width: 100, height: 60 }; h.UIImages.scan(h.root); h.tick(16);
  assert.equal(h.startedImages.length, 7);
});

test('image replacement and release cancel stale callbacks without damaging child controls', () => {
  const h = harness(), el = h.element(), badge = h.element('span'); h.root.appendChild(el); el.appendChild(badge);
  h.UIImages.watch(el, '/old', 'Old'); h.tick(16); const stale = h.startedImages[0].onload;
  h.UIImages.watch(el, '/new', 'New'); h.tick(16); stale();
  assert.equal(el.style.backgroundImage, ''); h.startedImages[1].onload(); h.tick(16);
  assert.equal(el.style.backgroundImage, 'url("/new")'); assert.equal(el.children[0], badge);
  h.UIImages.watch(el, '', 'Empty'); h.UIImages.watch(el, '', 'Empty');
  assert.equal(el.children.length, 2, 'empty repeated URLs do not duplicate fallback');
  h.UIImages.release(el); assert.equal(h.UIImages.stats().watched, 0); assert.equal(el.children.length, 1);
});

test('emotes have a separate concurrency and retained-image budget', () => {
  const h = harness(), nodes = [];
  for (let i = 0; i < 100; i++) {
    const el = h.element('img'); el.className = 'chat-emote'; h.root.appendChild(el); nodes.push(el);
    h.UIImages.watch(el, '/emote/' + i, ':wave:');
  }
  h.tick(16); assert.equal(h.startedImages.length, 2); assert.equal(h.UIImages.stats().emoteActive, 2);
  for (let round = 0; round < 48; round++) {
    for (const image of h.startedImages.slice()) if (image.onload) image.onload();
    h.tick(16);
  }
  assert.equal(h.UIImages.stats().emoteResident, 96);
  assert.equal(nodes[96].getAttribute('data-ui-image-state'), 'waiting'); assert.equal(nodes[96].alt, ':wave:');
  const artwork = h.element(); h.root.appendChild(artwork); h.UIImages.watch(artwork, '/poster', 'Poster'); h.tick(16);
  assert.equal(h.startedImages.length, 97, 'emotes leave artwork capacity available');
  h.UIImages.release(h.root); assert.equal(h.UIImages.stats().active, 0); assert.equal(h.UIImages.stats().watched, 0);
  assert.equal(h.UIImages.stats().emoteResident, 0);
});

test('offscreen history does not consume the live emote budget and old animations unload', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) {
    const el = h.element('img', 3000); el.className = 'chat-emote'; h.root.appendChild(el); h.UIImages.watch(el, '/old/' + i, ':old:');
  }
  const live = h.element('img'); live.className = 'chat-emote'; h.root.appendChild(live); h.UIImages.watch(live, '/live', ':live:');
  h.tick(16); assert.equal(h.startedImages.length, 1); assert.equal(h.startedImages[0].url, '/live');
  h.startedImages[0].onload(); h.tick(16); assert.equal(h.UIImages.stats().emoteResident, 1);
  live.rect.top = 3000; live.rect.bottom = 3060; h.UIImages.scan(h.root); h.tick(16);
  assert.equal(live.src, ''); assert.equal(h.UIImages.stats().emoteResident, 0);
  assert.equal(live.getAttribute('data-ui-image-state'), 'waiting');
});

test('repeated failed image URLs use a bounded, expiring negative cache', () => {
  const h = harness();
  function add(url) { const el = h.element('img'); h.root.appendChild(el); h.UIImages.watch(el, url, 'Fallback'); return el; }
  add('/broken'); h.tick(16); h.startedImages[0].onerror(); h.tick(16);
  const repeated = add('/broken'); h.tick(16);
  assert.equal(h.startedImages.length, 1); assert.equal(repeated.getAttribute('data-ui-image-state'), 'error');
  h.tick(300000); add('/broken'); h.tick(16); assert.equal(h.startedImages.length, 2, 'failed URLs retry after five minutes');
  h.startedImages[1].onerror(); h.tick(16);
  for (let i = 0; i < 64; i++) { add('/failure/' + i); h.tick(16); h.startedImages[h.startedImages.length - 1].onerror(); h.tick(16); }
  assert.equal(h.UIImages.stats().failedURLs, 64);
  const before = h.startedImages.length; add('/broken'); h.tick(16);
  assert.equal(h.startedImages.length, before + 1, 'least recently used failure was evicted');
});

test('640-node chat rescans preserve loaded live emotes and admit old rows on scroll', () => {
  const h = harness(), nodes = [];
  for (let i = 0; i < 640; i++) {
    const el = h.element('img', i < 600 ? 3000 : 20); el.className = 'chat-emote';
    el.setAttribute('data-ui-src', '/emote/' + i); el.alt = ':wave:'; h.root.appendChild(el); nodes.push(el);
  }
  h.UIImages.scan(h.root); h.tick(16);
  for (let round = 0; round < 20; round++) {
    for (const image of h.startedImages.slice()) if (image.onload) image.onload();
    h.tick(16);
  }
  assert.equal(h.UIImages.stats().emoteResident, 40); assert.equal(h.startedImages.length, 40);
  const urls = nodes.slice(600).map(el => el.src);
  h.UIImages.scan(h.root); h.tick(16);
  assert.equal(h.UIImages.stats().emoteResident, 40, 'unchanged scan must not evict loaded live emotes');
  assert.equal(h.startedImages.length, 40, 'unchanged scan starts no duplicate image requests');
  assert.deepEqual(nodes.slice(600).map(el => el.src), urls);
  assert.equal(h.UIImages.stats().watched, 40, 'distant unregistered history does not fill the registry');
  nodes[0].rect.top = 20; nodes[0].rect.bottom = 80;
  nodes[600].rect.top = 3000; nodes[600].rect.bottom = 3060;
  h.dispatch('scroll', h.root); h.tick(16);
  assert.equal(h.startedImages.length, 41); assert.equal(h.startedImages[40].url, '/emote/0');
  h.startedImages[40].onload(); h.tick(16);
  assert.equal(nodes[0].src, '/emote/0'); assert.equal(nodes[600].src, '');
  assert.equal(h.UIImages.stats().emoteResident, 40);
});

test('full nearby image registries preserve admitted images across excess-node rescans', () => {
  const h = harness(), nodes = [];
  for (let i = 0; i < 640; i++) {
    const el = h.element('img'); el.className = 'chat-emote'; el.setAttribute('data-ui-src', '/near/' + i);
    h.root.appendChild(el); nodes.push(el);
  }
  h.UIImages.scan(h.root); h.tick(16);
  for (let round = 0; round < 48; round++) {
    for (const image of h.startedImages.slice()) if (image.onload) image.onload();
    h.tick(16);
  }
  const admitted = nodes.filter(el => el._uiImage).map(el => el.getAttribute('data-ui-src'));
  const loaded = nodes.filter(el => el.src).map(el => el.src);
  assert.equal(admitted.length, 512); assert.equal(loaded.length, 96);
  h.UIImages.scan(h.root); h.tick(16);
  assert.deepEqual(nodes.filter(el => el._uiImage).map(el => el.getAttribute('data-ui-src')), admitted, 'capacity skips excess instead of evicting nearby records');
  assert.deepEqual(nodes.filter(el => el.src).map(el => el.src), loaded); assert.equal(h.startedImages.length, 96);
});
