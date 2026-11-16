const assert = require('node:assert/strict');
const test = require('node:test');
const { harness: sharedHarness } = require('./chat-harness.js');
// The original three tests index straight into the timer list, so keep that shape.
function harness(options) {
  const all = sharedHarness(options);
  return Object.assign({ h: all.h, requests: all.requests, sockets: all.sockets, timers: all.timers }, { all });
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

/* What the socket is for. It carries chat when chat is on, and the channel's own
   events (a raid) when raid follow is on; either alone is enough to open it. */
test('chat subscribes to the three channels Kick spreads a chat room over', () => {
  const { all } = harness();
  const socket = all.connect();
  assert.deepEqual(all.subscribed(socket), ['chatrooms.1.v2', 'chatrooms.1', 'chatroom_1']);
});
test('raid follow adds the channel\'s own events to an open chat', () => {
  const { all } = harness({ settings: { raidFollow: true } });
  assert.deepEqual(all.subscribed(all.connect()), ['chatrooms.1.v2', 'chatrooms.1', 'chatroom_1', 'channel.42']);
});
test('raid follow alone opens the socket for the channel\'s events and nothing else', () => {
  const { all } = harness({ settings: { chat: false, raidFollow: true } });
  const socket = all.connect();
  assert.deepEqual(all.subscribed(socket), ['channel.42']);
  all.event(socket, 'chatrooms.1.v2', 'App\\Events\\ChatMessageEvent', all.message('m1', 5, 'hello'));
  assert.equal(all.shown.length, 0, 'chat is off: nothing is shown');
});
test('with chat and raid follow both off there is no socket at all', () => {
  const { all } = harness({ settings: { chat: false } });
  all.h.syncChat();
  assert.equal(all.requests.length, 0);
});
test('turning chat off and on again reuses the open socket', () => {
  const { all } = harness({ settings: { raidFollow: true } });
  const socket = all.connect();
  all.h.settings.chat = false; all.h.syncChat();
  assert.equal(all.requests.length, 1, 'no second connection');
  assert.deepEqual(all.unsubscribed(socket), ['chatrooms.1.v2', 'chatrooms.1', 'chatroom_1']);
  all.event(socket, 'chatrooms.1.v2', 'App\\Events\\ChatMessageEvent', all.message('late', 5, 'still arriving'));
  assert.equal(all.shown.length, 0, 'a message already on its way is not shown once chat is off');
  all.h.settings.chat = true; all.h.syncChat(); all.settle();
  assert.equal(all.sockets.length, 1);
  assert.deepEqual(all.subscribed(socket).slice(4), ['chatrooms.1.v2', 'chatrooms.1', 'chatroom_1']);
  all.event(socket, 'chatrooms.1.v2', 'App\\Events\\ChatMessageEvent', all.message('m2', 5, 'back'));
  assert.deepEqual(all.shown.map(m => m.id), ['m2']);
});
test('turning the last use off closes the socket', () => {
  const { all } = harness({ settings: { raidFollow: true } });
  const socket = all.connect();
  all.h.settings.chat = false; all.h.settings.raidFollow = false; all.h.syncChat();
  assert.equal(socket.readyState, 3);
});
test('a dropped socket reconnects for raid follow even with chat off', () => {
  const { all } = harness({ settings: { chat: false, raidFollow: true } });
  const socket = all.connect();
  socket.close();
  all.tick(1500);
  assert.equal(all.requests.length, 2);
});
