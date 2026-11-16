const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./chat-harness.js');

// Values built inside the VM belong to another realm; copy them before comparing.
const plain = value => JSON.parse(JSON.stringify(value));
const sevenTvCalls = all => all.calls.filter(c => c.method === 'sevenTv');
const payloads = all => plain(sevenTvCalls(all).map(c => c.payload));
const answer = (all, payload, emotes) => {
  const call = sevenTvCalls(all).find(c => !c.done && JSON.stringify(c.payload) === JSON.stringify(payload));
  call.done = true; call.cb(null, { emotes });
};
const GAMBA = '01G3WEGZN0000ET2J0MQP5YJ0G', CLAP = '62fc0a0c4a75fd54bd3520a9', OTHER = '60ae7316f7c927fad14e6ca2';

/* 7TV emotes: Kick sends them as plain words, and the viewer's side swaps in the
   picture from the channel's set or the global one. */
test('opening chat asks for the global set and the channel\'s set, once each', () => {
  const all = harness();
  all.connect();
  assert.deepEqual(payloads(all), [{ global: true }, { userId: 7 }]);
  all.h.syncChat();
  assert.equal(sevenTvCalls(all).length, 2);
});
test('words that name an emote become emotes, and the text around them is kept exactly', () => {
  const all = harness();
  all.connect();
  answer(all, { global: true }, [['Clap', CLAP]]);
  answer(all, { userId: 7 }, [['GAMBA', GAMBA]]);
  assert.deepEqual(plain(all.h.chatTextParts('hello GAMBA  world Clap')), [
    { text: 'hello ' }, { emote: GAMBA, name: 'GAMBA' }, { text: '  world ' }, { emote: CLAP, name: 'Clap' }]);
  assert.deepEqual(plain(all.h.chatTextParts('GAMBA')), [{ emote: GAMBA, name: 'GAMBA' }]);
  assert.deepEqual(plain(all.h.chatTextParts('gamba GAMBA! notGAMBA')), [{ text: 'gamba GAMBA! notGAMBA' }], 'whole words, exact case');
});
test('the channel\'s emote wins over a global one with the same name', () => {
  const all = harness();
  all.connect();
  answer(all, { global: true }, [['Clap', CLAP]]);
  answer(all, { userId: 7 }, [['Clap', OTHER]]);
  assert.deepEqual(plain(all.h.chatTextParts('Clap')), [{ emote: OTHER, name: 'Clap' }]);
});
test('text is left alone until a set has loaded, and for words that only look like object keys', () => {
  const all = harness();
  all.connect();
  assert.deepEqual(plain(all.h.chatTextParts('GAMBA constructor')), [{ text: 'GAMBA constructor' }]);
  answer(all, { global: true }, []);
  answer(all, { userId: 7 }, [['GAMBA', GAMBA]]);
  assert.deepEqual(plain(all.h.chatTextParts('constructor __proto__ toString hasOwnProperty')),
    [{ text: 'constructor __proto__ toString hasOwnProperty' }]);
  assert.deepEqual(plain(all.h.chatTextParts('')), []);
});
test('another channel uses its own set, never the previous channel\'s', () => {
  const all = harness();
  all.connect();
  answer(all, { global: true }, []);
  answer(all, { userId: 7 }, [['GAMBA', GAMBA]]);
  all.h.state.current = 'beta';
  all.connect();
  assert.deepEqual(plain(all.h.chatTextParts('GAMBA')), [{ text: 'GAMBA' }], 'beta\'s set has not arrived');
  answer(all, { userId: 8 }, [['GAMBA', OTHER]]);
  assert.deepEqual(plain(all.h.chatTextParts('GAMBA')), [{ emote: OTHER, name: 'GAMBA' }]);
  all.h.state.current = 'alpha';
  all.connect();
  assert.equal(sevenTvCalls(all).length, 3, 'alpha\'s set is still in memory');
  assert.deepEqual(plain(all.h.chatTextParts('GAMBA')), [{ emote: GAMBA, name: 'GAMBA' }]);
});
test('a channel without 7TV is remembered as having none; a failed lookup is tried again later', () => {
  const all = harness();
  all.connect();
  const [global, channel] = sevenTvCalls(all);
  channel.cb(404);
  global.cb('timeout');
  all.h.disconnectChat(); all.connect();
  assert.equal(sevenTvCalls(all).length, 2, 'neither is asked again straight away');
  all.tick(5 * 60000 + 1);
  all.h.disconnectChat(); all.connect();
  assert.deepEqual(payloads(all).slice(2), [{ global: true }], 'only the failed one is retried');
});
test('a channel with no known owner id only uses the global set', () => {
  const all = harness();
  delete all.h.state.channels.alpha.userId;
  all.connect();
  assert.deepEqual(payloads(all), [{ global: true }]);
});
test('only a few channels\' sets are kept in memory', () => {
  const all = harness();
  for (let i = 0; i < 7; i++) {
    all.h.state.channels['c' + i] = { slug: 'c' + i, live: true, channelId: 100 + i, chatroomId: 200 + i, userId: 300 + i };
    all.h.state.current = 'c' + i;
    all.connect();
    sevenTvCalls(all).filter(c => !c.done).forEach(c => { c.done = true; c.cb(null, { emotes: [['E' + i, GAMBA]] }); });
  }
  const kept = Object.keys(all.h.sevenTv.sets).filter(k => k !== 'global');
  assert.equal(kept.length, 4);
  assert.ok(kept.includes('306'), 'the current channel is among them');
});
test('with emotes set to text nothing is fetched', () => {
  const all = harness({ settings: { chatEmotes: 'text' } });
  all.connect();
  assert.equal(sevenTvCalls(all).length, 0);
});
