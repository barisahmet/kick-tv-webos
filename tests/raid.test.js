const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./chat-harness.js');

/* Raid follow. When a streamer ends by sending the audience to another channel,
   Kick tells every viewer on the channel's own Pusher channel, and its website
   moves them there after a short countdown. This does the same, with a way out. */
const MOVE = 'App\\Events\\ChatMoveToSupportedChannelEvent';
const raidTo = (slug = 'nova', username = 'Nova') => ({ channel: { id: 42, slug: 'alpha' }, slug: 'alpha',
  hosted: { id: 99, username, slug, viewers_count: 1200, is_live: true, profile_pic: null } });
function raidHarness(options = {}) {
  const all = harness({ settings: Object.assign({ raidFollow: true }, options.settings), state: options.state });
  all.socket = all.connect();
  all.raid = (data = raidTo()) => all.event(all.socket, 'channel.42', MOVE, data);
  // Let minutes pass on a healthy connection (traffic keeps the heartbeat from recycling the socket).
  all.minutes = (n) => { for (let i = 0; i < n; i++) { all.tick(60000); all.socket.onmessage({ data: JSON.stringify({ event: 'pusher:pong', data: '{}' }) }); } };
  return all;
}

test('a raid offers to follow and does so when the countdown ends', () => {
  const all = raidHarness();
  all.raid();
  assert.equal(all.h.raid.open, true);
  assert.equal(all.h.raid.title, 'Alpha is raiding Nova');
  assert.equal(all.h.raidLeftSec(), 10);
  all.tick(9000);
  assert.deepEqual(all.played, []);
  assert.equal(all.h.raidLeftSec(), 1);
  all.tick(1000);
  assert.deepEqual(all.played, ['nova']);
  assert.equal(all.h.raid.open, false);
});
test('raid follow works with chat switched off', () => {
  const all = raidHarness({ settings: { chat: false } });
  all.raid();
  assert.equal(all.h.raid.open, true);
});
test('Back keeps the current stream', () => {
  const all = raidHarness();
  all.raid();
  all.h.raidKey(all.h.KEY.BACK);
  assert.equal(all.h.raid.open, false);
  all.tick(60000);
  assert.deepEqual(all.played, []);
});
test('OK starts on Stay, so a stray press does not change the channel', () => {
  const all = raidHarness();
  all.raid();
  all.h.raidKey(all.h.KEY.OK);
  assert.equal(all.h.raid.open, false);
  all.tick(60000);
  assert.deepEqual(all.played, []);
});
test('Left then OK goes now', () => {
  const all = raidHarness();
  all.raid();
  all.h.raidKey(all.h.KEY.LEFT);
  all.h.raidKey(all.h.KEY.OK);
  assert.deepEqual(all.played, ['nova']);
  all.tick(60000);
  assert.deepEqual(all.played, ['nova'], 'the countdown does not fire a second time');
});
test('the countdown allows for how far the picture trails the live event', () => {
  const lagging = raidHarness();
  lagging.h.liveLatencySec = () => 14.4;
  lagging.raid();
  assert.equal(lagging.h.raidLeftSec(), 19);
  const far = raidHarness();
  far.h.liveLatencySec = () => 300;
  far.raid();
  assert.equal(far.h.raidLeftSec(), 30);
});
test('Kick repeating the event does not restart the countdown', () => {
  const all = raidHarness();
  all.raid();
  all.tick(6000);
  all.raid();
  assert.equal(all.h.raidLeftSec(), 4);
});
test('with a menu open the raid is only announced, never acted on', () => {
  const all = raidHarness();
  all.h.anyPanelOpen = () => true;
  all.raid();
  assert.equal(all.h.raid.open, false);
  assert.deepEqual(all.toasts, ['Alpha is raiding Nova']);
  all.tick(60000);
  assert.deepEqual(all.played, []);
});
test('events that cannot be followed are ignored', () => {
  const all = raidHarness();
  for (const data of [{}, { hosted: null }, { hosted: {} }, raidTo('alpha'), raidTo('../evil'), raidTo(''), raidTo(42)]) all.raid(data);
  assert.equal(all.h.raid.open, false);
  all.h.document.hidden = true;
  all.raid();
  assert.equal(all.h.raid.open, false, 'not while another app is in front');
});
test('a name that is missing falls back to the channel address', () => {
  const all = raidHarness();
  all.raid(raidTo('nova', null));
  assert.equal(all.h.raid.title, 'Alpha is raiding nova');
});
test('switching channel by hand drops the offer', () => {
  const all = raidHarness();
  all.raid();
  all.h.state.current = 'beta';
  all.tick(60000);
  assert.equal(all.h.raid.open, false);
  assert.deepEqual(all.played, []);
});
test('turning raid follow off drops a pending offer', () => {
  const all = raidHarness();
  all.raid();
  all.h.settings.raidFollow = false;
  all.tick(60000);
  assert.deepEqual(all.played, []);
});
test('if the stream ends during the countdown the raid is followed at once', () => {
  const all = raidHarness();
  all.raid();
  assert.equal(all.h.followRaidFrom('beta'), false, 'another channel ending is not this raid');
  assert.equal(all.h.followRaidFrom('alpha'), true);
  assert.deepEqual(all.played, ['nova']);
  assert.equal(all.h.followRaidFrom('alpha'), false, 'and only once');
});
test('a raid the viewer declined is not followed when the stream then ends', () => {
  const all = raidHarness();
  all.raid();
  all.h.raidKey(all.h.KEY.BACK);
  assert.equal(all.h.followRaidFrom('alpha'), false);
  assert.deepEqual(all.played, []);
});

/* Review findings */
test('a raid the viewer declined is not offered again when Kick repeats the announcement', () => {
  const all = raidHarness();
  all.raid();
  all.h.raidKey(all.h.KEY.BACK);
  all.tick(3000);
  all.raid();
  assert.equal(all.h.raid.open, false);
  all.tick(60000);
  assert.deepEqual(all.played, []);
  assert.deepEqual(all.toasts, []);
});
test('declining one raid does not hide a raid to a different channel', () => {
  const all = raidHarness();
  all.raid();
  all.h.raidKey(all.h.KEY.BACK);
  all.raid(raidTo('orion', 'Orion'));
  assert.equal(all.h.raid.open, true);
  assert.equal(all.h.raid.title, 'Alpha is raiding Orion');
});
test('the same raid much later in the stream is a new raid', () => {
  const all = raidHarness();
  all.raid();
  all.h.raidKey(all.h.KEY.BACK);
  all.minutes(11);
  all.raid();
  assert.equal(all.h.raid.open, true);
});
test('with a menu open a repeated announcement is said once', () => {
  const all = raidHarness();
  all.h.anyPanelOpen = () => true;
  all.raid(); all.tick(2000); all.raid();
  assert.deepEqual(all.toasts, ['Alpha is raiding Nova']);
});
test('the channel list counts as a menu: the raid is announced, not acted on', () => {
  const all = raidHarness();
  all.h.state.sidebarOpen = true;
  all.raid();
  assert.equal(all.h.raid.open, false);
  assert.deepEqual(all.toasts, ['Alpha is raiding Nova']);
  all.tick(60000);
  assert.deepEqual(all.played, []);
});
