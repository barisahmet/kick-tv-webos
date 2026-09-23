const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../services/com.barisahmet.kicktv.service/service.js'), 'utf8');

function harness() {
  const handlers = {}, requests = [];
  function Service() { this.register = (name, fn) => { handlers[name] = fn; }; }
  const https = {
    Agent: function (options) { this.options = options; },
    get(options, cb) {
      const req = new EventEmitter(); req.setTimeout = (ms, fn) => { req.timeout = fn; };
      req.abort = () => req.emit('error', Error('aborted'));
      requests.push({ options, cb, req }); return req;
    }
  };
  const timers = [];
  const context = { require: name => name === 'webos-service' ? Service : name === 'https' ? https : assert.fail(name), Buffer, process,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.cleared = true; } };
  vm.createContext(context); vm.runInContext(source, context);
  function begin(payload) {
    const replies = []; handlers.fetch({ payload, respond: value => replies.push(value) });
    return { replies, request: requests[requests.length - 1] };
  }
  function response(request, body, status = 200, headers = {}) {
    const res = new EventEmitter(); res.statusCode = status; res.headers = headers; res.setEncoding = value => { res.encoding = value; };
    request.cb(res); res.emit('data', body); return res;
  }
  function fetch(endpoint, value, compact = true, status = 200) {
    const { replies, request } = begin({ path: endpoint, compact });
    response(request, JSON.stringify(value), status).emit('end');
    return JSON.parse(replies[0].body);
  }
  return { ...context, handlers, begin, response, fetch, requests, timers };
}

const image = { src: 'https://images.test/large.webp', srcset: 'https://images.test/small.webp 480w', responsive: 'https://images.test/cat.webp 400w', url: 'https://images.test/fallback.webp' };
const category = { id: 3, slug: 'games', name: 'Games', banner: image, viewer_count: 21, viewers: 22, livestreams_count: 2, unused: 'omit' };
const livestream = { id: 8, slug: 'channel', is_live: true, viewer_count: 99, language: 'en', session_title: 'Test stream', created_at: '2026-09-12T10:00:00Z', thumbnail: image, categories: [category], channel: { id: 1, slug: 'channel', user: { id: 2, username: 'Channel', profile_pic: '/avatar', secret: 'unused' } }, unused: 'omit' };
const channel = { id: 1, slug: 'channel', playback_url: 'https://stream.test/live.m3u8?token=fake', followers_count: 90, followersCount: 90, isLive: true, is_live: true, user: { id: 2, username: 'Channel', profile_pic: '/avatar', unused: 'omit' }, livestream, chatroom: { id: 4, unused: 'omit' }, unused: 'omit' };
const vod = { id: 88, uuid: 'outer-id', source: 'https://stream.test/vod.m3u8?token=fake', duration: 7200000, created_at: '2026-09-12T10:00:00Z', session_title: 'Past stream', is_live: false, views: 18, thumbnail: image, categories: [category], video: { id: 89, uuid: 'stable-id', thumb: image, unused: 'omit' }, unused: 'omit' };
function at(value, key) { return key.split('.').reduce((v, k) => v == null ? undefined : v[k], value); }
function parity(raw, projected, paths) { for (const key of paths) assert.deepEqual(at(projected, key), at(raw, key), key); }

test('channel projection preserves normalization, chat, playback and preview fields', () => {
  const h = harness();
  for (const version of ['v1', 'v2']) {
    const projected = h.fetch('/api/' + version + '/channels/channel', channel);
    parity(channel, projected, ['slug', 'playback_url', 'user.username', 'user.profile_pic', 'livestream.is_live', 'livestream.viewer_count', 'livestream.session_title', 'livestream.created_at', 'livestream.thumbnail', 'livestream.categories.0.name', 'livestream.categories.0.slug', 'chatroom.id']);
    assert.equal(projected.unused, undefined); assert.equal(projected.user.unused, undefined);
  }
  const offline = h.fetch('/api/v2/channels/offline', { user: null, chatroom: null, livestream: null });
  assert.deepEqual(offline, { user: null, chatroom: null, livestream: null });
});

test('directory and category projections preserve wrappers and image descriptor shapes', () => {
  const h = harness();
  const result = h.fetch('/stream/livestreams/en?page=1', { data: [livestream], next_page_url: '/next', meta: { page: 1 } });
  parity(livestream, result.data[0], ['viewer_count', 'language', 'session_title', 'created_at', 'thumbnail', 'categories.0.name', 'categories.0.slug', 'channel.slug', 'channel.user.username']);
  assert.equal(result.next_page_url, '/next'); assert.deepEqual(result.meta, { page: 1 }); assert.equal(result.data[0].unused, undefined);
  const cats = h.fetch('/api/v1/subcategories?page=2', { data: [category], current_page: 2 });
  parity(category, cats.data[0], ['id', 'slug', 'name', 'banner', 'viewers', 'viewer_count', 'livestreams_count']);
  assert.equal(cats.current_page, 2);
  const stringImage = h.fetch('/stream/livestreams/en', { data: [{ thumbnail: '/image.jpg', categories: null, channel: null }] });
  assert.deepEqual(stringImage, { data: [{ thumbnail: '/image.jpg', categories: null, channel: null }] });
});

test('VOD projection preserves playback validation, nested identity, progress matching and poster fallbacks', () => {
  const h = harness();
  for (const payload of [[vod], { data: [vod], next_cursor: 9 }]) {
    const result = h.fetch('/api/v2/channels/channel/videos', payload);
    const projected = Array.isArray(result) ? result[0] : result.data[0];
    parity(vod, projected, ['id', 'uuid', 'source', 'duration', 'created_at', 'session_title', 'is_live', 'views', 'thumbnail', 'categories.0.name', 'categories.0.slug', 'video.id', 'video.uuid', 'video.thumb']);
    assert.equal(projected.unused, undefined); assert.equal(projected.video.unused, undefined);
    assert.equal(Array.isArray(result), Array.isArray(payload));
  }
});

test('search preserves channel suggestions and category search in the same response', () => {
  const h = harness();
  const result = h.fetch('/api/search?searched_word=ch', { channels: [channel], categories: [category], query: 'ch' });
  parity(channel, result.channels[0], ['slug', 'user.username', 'followers_count', 'followersCount', 'isLive', 'is_live']);
  parity(category, result.categories[0], ['slug', 'name', 'banner', 'viewers', 'viewer_count']);
  assert.equal(result.query, 'ch'); assert.equal(result.channels[0].unused, undefined);
});

test('compact is explicit, unrecognized endpoints are unchanged, and invalid JSON remains unchanged', () => {
  const h = harness(), body = '  ' + JSON.stringify(channel) + '\n';
  for (const compact of [undefined, false, 1, 'true']) {
    const pending = h.begin({ path: '/api/v2/channels/channel', compact }); h.response(pending.request, body).emit('end');
    assert.equal(pending.replies[0].body, body);
  }
  for (const endpoint of ['/api/v2/new-endpoint', '/api/v2/channels/channel/extra', '/api/v2/channels/channel/videos/extra']) {
    const pending = h.begin({ path: endpoint, compact: true }); h.response(pending.request, body).emit('end'); assert.equal(pending.replies[0].body, body);
  }
  const malformed = h.begin({ path: '/api/v2/channels/channel', compact: true }); h.response(malformed.request, '{broken').emit('end'); assert.equal(malformed.replies[0].body, '{broken');
  const rejected = h.begin({ path: '/api/v2/channels/channel', compact: true }); h.response(rejected.request, body, 403).emit('end'); assert.equal(rejected.replies[0].body, body);
});

test('network failure, truncation, and duplicate response events settle once', () => {
  const h = harness();
  const bad = h.begin({ path: '/other/path' }); assert.equal(bad.replies[0].error, 'bad path');
  const truncated = h.begin({ path: '/api/v2/channels/channel' });
  const res = h.response(truncated.request, '{}', 200, { 'content-length': '10' }); res.emit('end'); res.emit('aborted');
  assert.equal(truncated.replies.length, 1); assert.equal(truncated.replies[0].error, 'truncated response');
  const aborted = h.begin({ path: '/api/v2/channels/channel' });
  const res2 = h.response(aborted.request, '{}'); res2.emit('aborted'); res2.emit('end'); aborted.request.req.emit('error', Error('late'));
  assert.equal(aborted.replies.length, 1); assert.equal(aborted.replies[0].error, 'response aborted');
  const timeout = h.begin({ path: '/api/v2/channels/channel' }); timeout.request.req.timeout(); assert.equal(timeout.replies[0].error, 'aborted');
});

test('TLS fingerprint constants and connection reuse are unchanged', () => {
  const h = harness(); h.begin({ path: '/api/v2/channels/channel' });
  const options = h.requests[0].options;
  assert.equal(options.ecdhCurve, 'X25519:prime256v1:secp384r1');
  assert.equal(options.ciphers, ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305', 'AES128-GCM-SHA256', 'AES256-GCM-SHA384'].join(':'));
  assert.equal(options.agent.options.keepAlive, true); assert.equal(options.agent.options.maxSockets, 6);
});

test('slow, oversized and unsendable requests still answer exactly once', () => {
  const h = harness();
  // an overall deadline, independent of the idle timeout
  const slow = h.begin({ path: '/api/v2/channels/channel' });
  const deadline = h.timers[h.timers.length - 1];
  assert.equal(deadline.ms, 11000);
  const res = h.response(slow.request, '{"a":');
  deadline.fn(); res.emit('data', '1}'); res.emit('end');
  assert.equal(slow.replies.length, 1); assert.equal(slow.replies[0].error, 'timeout');
  // a finished request clears its deadline
  const quick = h.begin({ path: '/api/v2/channels/channel' });
  const quickDeadline = h.timers[h.timers.length - 1];
  h.response(quick.request, '{}').emit('end');
  assert.equal(quickDeadline.cleared, true);
  // declared or streamed bodies past the cap are refused
  const declared = h.begin({ path: '/api/v2/channels/channel' });
  h.response(declared.request, '', 200, { 'content-length': String(9 * 1024 * 1024) });
  assert.equal(declared.replies.length, 1); assert.equal(declared.replies[0].error, 'too large');
  const streamed = h.begin({ path: '/api/v2/channels/channel' });
  const big = h.response(streamed.request, 'x'.repeat(5 * 1024 * 1024));
  big.emit('data', 'x'.repeat(5 * 1024 * 1024)); big.emit('end');
  assert.equal(streamed.replies.length, 1); assert.equal(streamed.replies[0].error, 'too large');
  // paths https.get would throw on are rejected up front
  for (const p of ['/api/v2/channels/a b', '/api/v2/channels/ç']) {
    const r = h.begin({ path: p }); assert.equal(r.replies[0].error, 'bad path');
  }
});
