const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../app/js/chat-overlay.js'), 'utf8');
function harness() {
  const requests = [], sockets = [], timers = [];
  const h = {
    settings: { chat: true, chatDelay: 0 },
    state: { current: 'alpha', channels: { alpha: { channelId: 42, chatroomId: 1 }, beta: { channelId: 43, chatroomId: 2 } } },
    window: {}, ChatWindow: { status() {} },
    serviceChatConnection(id, cb) {
      const request = { id, cb, cancelled: false }; requests.push(request);
      return () => { request.cancelled = true; };
    },
    setTimeout(fn, ms) { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cancelled = true; },
    WebSocket: function (url) {
      this.url = url; this.readyState = 0; this.sent = [];
      this.send = msg => this.sent.push(JSON.parse(msg));
      this.close = () => { this.readyState = 3; if (this.onclose) this.onclose(); };
      sockets.push(this);
    }
  };
  vm.createContext(h); vm.runInContext(source, h);
  h.clearChat = h.showChatOverlay = h.hideChatOverlay = h.applyStreamerChatPreferences = () => {};
  return { h, requests, sockets, timers };
}
function descriptor(key, cluster = 'us2') {
  return { data: { mode: 'websocket', connections: [{ provider: 'pusher', credentials: { app_key: key, cluster } }] } };
}
test('chat discovers credentials and refreshes them after key rotation', () => {
  const { h, requests, sockets, timers } = harness();
  h.connectChat(1);
  assert.equal(sockets.length, 0);
  assert.equal(requests[0].id, 42);
  h.syncChat(); assert.equal(requests.length, 1, 'sync coalesces pending discovery');
  requests[0].cb(null, descriptor('first-key'));
  assert.match(sockets[0].url, /ws-us2\.pusher\.com\/app\/first-key\?/);
  sockets[0].onmessage({ data: JSON.stringify({ event: 'pusher:connection_established', data: '{"activity_timeout":120}' }) });
  assert.equal(sockets[0].sent[0].data.channel, 'chatrooms.1.v2');
  sockets[0].close();
  timers[timers.length - 1].fn();
  assert.equal(requests.length, 2);
  requests[1].cb(null, descriptor('next-key', 'eu'));
  assert.match(sockets[1].url, /ws-eu\.pusher\.com\/app\/next-key\?/);
});
test('switching channels or closing chat discards late discovery responses', () => {
  const { h, requests, sockets } = harness();
  h.connectChat(1);
  h.state.current = 'beta'; h.connectChat(2);
  assert.equal(requests[0].cancelled, true);
  requests[0].cb(null, descriptor('old-key'));
  assert.equal(sockets.length, 0);
  requests[1].cb(null, descriptor('new-key'));
  assert.equal(sockets.length, 1);
  h.state.current = 'alpha'; h.connectChat(1);
  h.disconnectChat(); h.connectChat(1);
  requests[2].cb(null, descriptor('stale-same-room'));
  assert.equal(sockets.length, 1);
  h.disconnectChat(); requests[3].cb(null, descriptor('closed'));
  assert.equal(sockets.length, 1);
});
test('descriptor errors and unsupported providers retry without using an obsolete key', () => {
  for (const result of [null, { data: { mode: 'polling', connections: [] } }, descriptor('bad/key'), descriptor('key', 'bad.host')]) {
    const { h, requests, sockets, timers } = harness();
    h.connectChat(1); requests[0].cb(result ? null : 'network', result);
    assert.equal(sockets.length, 0);
    assert.equal(timers[timers.length - 1].ms, 1500);
    timers[timers.length - 1].fn(); assert.equal(requests.length, 2);
  }
});
