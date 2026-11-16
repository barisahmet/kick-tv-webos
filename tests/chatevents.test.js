const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./chat-harness.js');

const ROOM = 'chatrooms.1.v2';
const EV = name => 'App\\Events\\' + name;
const historyOf = all => all.gets.filter(g => g.path === '/api/v2/channels/42/messages');
const pollOf = all => all.gets.filter(g => g.path === '/api/v2/channels/alpha/polls');
// Values built inside the VM belong to another realm; copy them before comparing.
const plain = value => JSON.parse(JSON.stringify(value));

/* Moderation. Kick tells every viewer when a message is deleted or a chatter is
   banned; the app used to leave those messages on screen. */
test('a deleted message leaves the screen', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m1', 5, 'fine'));
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m2', 6, 'not fine'));
  all.event(socket, ROOM, EV('MessageDeletedEvent'), { id: 'ev1', message: { id: 'm2' }, aiModerated: false, violatedRules: [] });
  assert.deepEqual(all.dropped, [['data-id', 'm2']]);
});
test('a message deleted while still held back for the video is never shown', () => {
  const all = harness({ settings: { chatDelay: 10 } }), socket = all.connect();
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m1', 5, 'spoiler'));
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m2', 6, 'kept'));
  all.event(socket, ROOM, EV('MessageDeletedEvent'), { id: 'ev1', message: { id: 'm1' } });
  all.tick(11000);
  assert.deepEqual(all.shown.map(m => m.id), ['m2']);
});
test('a banned or timed-out chatter\'s messages all go, shown and pending alike', () => {
  const all = harness({ settings: { chatDelay: 10 } }), socket = all.connect();
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m1', 5, 'spam'));
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m2', 6, 'hello'));
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m3', 5, 'more spam'));
  all.event(socket, ROOM, EV('UserBannedEvent'), { id: 'ev2', user: { id: 5, username: 'user5', slug: 'user5' }, permanent: false, duration: 5 });
  all.tick(11000);
  assert.deepEqual(all.shown.map(m => m.id), ['m2']);
  assert.deepEqual(all.dropped, [['data-uid', '5']]);
});
test('a moderator clearing the chat room clears the window', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m1', 5, 'one'));
  assert.equal(all.shown.length, 1);
  all.event(socket, ROOM, EV('ChatroomClearEvent'), { id: 'ev3' });
  assert.equal(all.shown.length, 0);
});
test('events with missing or malformed ids are ignored rather than matching everything', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m1', 5, 'stays'));
  for (const bad of [{}, { message: null }, { message: {} }]) all.event(socket, ROOM, EV('MessageDeletedEvent'), bad);
  for (const bad of [{}, { user: null }, { user: {} }]) all.event(socket, ROOM, EV('UserBannedEvent'), bad);
  assert.deepEqual(all.dropped, []);
  assert.equal(all.shown.length, 1);
});

/* History. Opening chat used to show an empty box until someone spoke; Kick
   serves the last messages and the pinned message for any room. */
test('opening chat fills it with the room\'s recent messages, oldest first', () => {
  const all = harness(), socket = all.connect({ pending: true });
  assert.equal(historyOf(all).length, 1);
  const t = all.now();
  historyOf(all)[0].cb(null, { data: { pinned_message: null, messages: [
    all.message('h3', 5, 'third', { created_at: new Date(t - 1000).toISOString() }),
    all.message('h1', 6, 'first', { created_at: new Date(t - 9000).toISOString() }),
    all.message('h2', 7, 'second', { created_at: new Date(t - 5000).toISOString() })] } });
  assert.deepEqual(all.shown.map(m => m.id), ['h1', 'h2', 'h3']);
  assert.equal(socket.readyState, 1);
});
test('a message that arrives both live and in the history is shown once', () => {
  const all = harness(), socket = all.connect({ pending: true });
  const live = all.message('same', 5, 'hello');
  all.event(socket, ROOM, EV('ChatMessageEvent'), live);
  historyOf(all)[0].cb(null, { data: { messages: [live, all.message('older', 6, 'earlier', { created_at: new Date(all.now() - 4000).toISOString() })] } });
  all.event(socket, ROOM, EV('ChatMessageEvent'), live);
  assert.deepEqual(all.shown.map(m => m.id).sort(), ['older', 'same']);
});
test('history respects the delay that keeps chat in step with the video', () => {
  const all = harness({ settings: { chatDelay: 10 } });
  all.connect({ pending: true });
  const t = all.now();
  historyOf(all)[0].cb(null, { data: { messages: [
    all.message('old', 5, 'already seen on the video', { created_at: new Date(t - 30000).toISOString() }),
    all.message('recent', 6, 'the video has not got here yet', { created_at: new Date(t - 4000).toISOString() })] } });
  all.tick(0);
  assert.deepEqual(all.shown.map(m => m.id), ['old']);
  all.tick(6000);
  assert.deepEqual(all.shown.map(m => m.id), ['old', 'recent']);
});
test('history that lands after leaving the channel is thrown away', () => {
  const all = harness();
  all.connect({ pending: true });
  const pending = historyOf(all)[0];
  all.h.disconnectChat();
  assert.equal(pending.cancelled, true);
  pending.cb(null, { data: { messages: [all.message('late', 5, 'too late')] } });
  assert.equal(all.shown.length, 0);
});
test('a reconnect asks for history again to fill the gap', () => {
  const all = harness(), socket = all.connect({ pending: true });
  historyOf(all)[0].cb(null, { data: { messages: [all.message('a', 5, 'before the drop')] } });
  socket.close();
  all.tick(1500);
  all.requests[1].cb(null, all.descriptor());
  all.sockets[1].readyState = 1;
  all.sockets[1].onmessage({ data: JSON.stringify({ event: 'pusher:connection_established', data: '{}' }) });
  assert.equal(historyOf(all).length, 2);
  historyOf(all)[1].cb(null, { data: { messages: [all.message('a', 5, 'before the drop'), all.message('b', 6, 'missed while down')] } });
  assert.deepEqual(all.shown.map(m => m.id), ['a', 'b']);
});

/* Pinned message. */
const pinned = (all, id, content, extra) => ({ message: all.message(id, 9, content), duration: 1200,
  finish_at: new Date(all.now() + 3600000).toISOString(), pinned_by: { id: 1, username: 'mod' }, ...extra });
test('the room\'s pinned message is picked up when chat opens', () => {
  const all = harness();
  all.connect({ pending: true });
  historyOf(all)[0].cb(null, { data: { messages: [], pinned_message: pinned(all, 'p1', 'Tournament day 2') } });
  assert.equal(all.h.chatPin.id, 'p1');
  assert.equal(all.heads[all.heads.length - 1].pin, 'p1');
});
test('a pin that has already run out is not shown', () => {
  const all = harness();
  all.connect({ pending: true });
  historyOf(all)[0].cb(null, { data: { messages: [], pinned_message: pinned(all, 'p1', 'old news', { finish_at: new Date(all.now() - 1000).toISOString() }) } });
  assert.equal(all.h.chatPin, null);
});
test('pinning and unpinning during the stream follow along', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('PinnedMessageCreatedEvent'), { message: all.message('p2', 9, 'Giveaway at 9'), duration: '1200', pinnedBy: { id: 1, username: 'mod' } });
  assert.equal(all.h.chatPin.id, 'p2');
  all.event(socket, ROOM, EV('PinnedMessageDeletedEvent'), {});
  assert.equal(all.h.chatPin, null);
  assert.equal(all.heads[all.heads.length - 1].pin, null);
});
test('a pin picked up from history comes down when its time runs out', () => {
  const all = harness();
  all.connect({ pending: true });
  historyOf(all)[0].cb(null, { data: { messages: [], pinned_message: pinned(all, 'p1', 'last hour', { finish_at: new Date(all.now() + 60000).toISOString() }) } });
  all.tick(59000);
  assert.equal(all.h.chatPin.id, 'p1');
  all.tick(2000);
  assert.equal(all.h.chatPin, null);
  assert.equal(all.heads[all.heads.length - 1].pin, null);
});
test('a pin made during the stream stays for the minutes Kick gives it', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('PinnedMessageCreatedEvent'), { message: all.message('p2', 9, 'twenty minutes'), duration: '20' });
  all.tick(19 * 60000);
  assert.equal(all.h.chatPin.id, 'p2');
  all.tick(60000 + 1);
  assert.equal(all.h.chatPin, null);
});
test('a newer pin is not taken down by the timer of the one it replaced', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('PinnedMessageCreatedEvent'), { message: all.message('p2', 9, 'short'), duration: '1' });
  all.event(socket, ROOM, EV('PinnedMessageCreatedEvent'), { message: all.message('p3', 9, 'long'), duration: '60' });
  all.tick(5 * 60000);
  assert.equal(all.h.chatPin.id, 'p3');
});
test('a pin event without a usable message clears the pin instead of breaking the header', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('PinnedMessageCreatedEvent'), { message: all.message('p2', 9, 'x') });
  all.event(socket, ROOM, EV('PinnedMessageCreatedEvent'), { message: null });
  assert.equal(all.h.chatPin, null);
});
test('leaving the channel forgets its pin and poll', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('PinnedMessageCreatedEvent'), { message: all.message('p2', 9, 'x') });
  all.event(socket, ROOM, EV('PollUpdateEvent'), { poll: { title: 'Next game?', options: [{ id: 0, label: 'A', votes: 1 }], remaining: 30, result_display_duration: 15 } });
  all.h.disconnectChat();
  assert.equal(all.h.chatPin, null); assert.equal(all.h.chatPoll, null);
});

/* Polls. */
const poll = (extra) => ({ title: 'Next game?', duration: 30, remaining: 30, result_display_duration: 15,
  options: [{ id: 0, label: 'Chess', votes: 3 }, { id: 1, label: 'Poker', votes: 1 }], ...extra });
test('a running poll is picked up when chat opens', () => {
  const all = harness();
  all.connect({ pending: true });
  assert.equal(pollOf(all).length, 1);
  pollOf(all)[0].cb(null, { data: { poll: poll() } });
  assert.equal(all.h.chatPoll.title, 'Next game?');
  assert.deepEqual(plain(all.h.chatPoll.options), [{ label: 'Chess', votes: 3 }, { label: 'Poker', votes: 1 }]);
});
test('no poll running is the usual answer and leaves nothing behind', () => {
  const all = harness();
  all.connect({ pending: true });
  pollOf(all)[0].cb(null, { status: { code: 404, error: true }, data: null });
  assert.equal(all.h.chatPoll, null);
});
test('poll votes update live, and the poll goes away after its results have been shown', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('PollUpdateEvent'), { poll: poll() });
  all.event(socket, ROOM, EV('PollUpdateEvent'), { poll: poll({ remaining: 20, options: [{ id: 0, label: 'Chess', votes: 9 }, { id: 1, label: 'Poker', votes: 4 }] }) });
  assert.deepEqual(plain(all.h.chatPoll.options).map(o => o.votes), [9, 4]);
  assert.equal(all.h.chatPollLeftSec(), 20);
  all.tick(21000);
  assert.equal(all.h.chatPollLeftSec(), 0);
  assert.notEqual(all.h.chatPoll, null, 'results stay up for a while');
  all.tick(15000);
  assert.equal(all.h.chatPoll, null);
});
test('a poll the streamer removes disappears at once', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('PollUpdateEvent'), { poll: poll() });
  all.event(socket, ROOM, EV('PollDeleteEvent'), {});
  assert.equal(all.h.chatPoll, null);
});
test('a malformed poll is ignored', () => {
  const all = harness(), socket = all.connect();
  for (const bad of [{}, { poll: null }, { poll: { title: 'x' } }, { poll: { title: 'x', options: 'no' } }, { poll: { options: [] } }])
    all.event(socket, ROOM, EV('PollUpdateEvent'), bad);
  assert.equal(all.h.chatPoll, null);
});

/* Subscriptions, gifts and raids appear as plain lines in the chat. */
const notices = all => all.shown.filter(m => m.notice).map(m => m.notice);
test('a new subscription and a renewal each get a line', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('SubscriptionEvent'), { chatroom_id: 1, username: 'Mira', months: 1 });
  all.event(socket, ROOM, EV('SubscriptionEvent'), { chatroom_id: 1, username: 'Tom', months: 7 });
  assert.deepEqual(notices(all), ['Mira subscribed', 'Tom subscribed for 7 months']);
});
test('a renewal announced as a celebration message gets a line, and its text is kept when it says something', () => {
  const all = harness(), socket = all.connect();
  const celebrate = (id, content) => all.message(id, 5, content, { type: 'celebration',
    metadata: { celebration: { id: 'c', type: 'subscription_renewed', total_months: 3 } } });
  all.event(socket, ROOM, EV('ChatMessageEvent'), celebrate('c1', '🎉'));
  all.event(socket, ROOM, EV('ChatMessageEvent'), celebrate('c2', 'three months already!'));
  assert.deepEqual(notices(all), ['user5 resubscribed for 3 months', 'user5 resubscribed for 3 months']);
  assert.deepEqual(all.shown.filter(m => !m.notice).map(m => m.id), ['c2']);
});
test('gifted subs get one line, however many pieces Kick sends them in', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, 'chatroom_1', 'GiftedSubscriptionsEvent', { chatroom_id: 1, gifted_usernames: ['Ana'], gifter_username: 'Raul', gifted_total: 1, chunk_details: null });
  const chunk = (index) => ({ chatroom_id: 1, gifted_usernames: ['a', 'b'], gifter_username: 'Big', gifted_total: 50,
    chunk_details: { correlation_id: 'x1', chunk_index: index, total_chunks: 3 } });
  all.event(socket, 'chatroom_1', 'GiftedSubscriptionsEvent', chunk(0));
  all.event(socket, 'chatroom_1', 'GiftedSubscriptionsEvent', chunk(1));
  all.event(socket, 'chatroom_1', 'GiftedSubscriptionsEvent', chunk(2));
  assert.deepEqual(notices(all), ['Raul gifted a sub to Ana', 'Big gifted 50 subs']);
});
test('an incoming raid gets a line with its size', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, 'chatrooms.1', EV('StreamHostedEvent'), { user: { username: 'Nova' }, message: { numberOfViewers: 1234 } });
  all.event(socket, 'chatrooms.1', EV('StreamHostedEvent'), { user: { username: 'Solo' }, message: { numberOfViewers: 1 } });
  assert.deepEqual(notices(all), ['Nova raided with 1,234 viewers', 'Solo raided with 1 viewer']);
});
test('with event lines switched off none of them are shown, and chat carries on', () => {
  const all = harness({ settings: { chatEvents: false } }), socket = all.connect();
  all.event(socket, ROOM, EV('SubscriptionEvent'), { username: 'Mira', months: 1 });
  all.event(socket, 'chatrooms.1', EV('StreamHostedEvent'), { user: { username: 'Nova' }, message: { numberOfViewers: 9 } });
  all.event(socket, ROOM, EV('ChatMessageEvent'), all.message('m1', 5, 'hi'));
  assert.deepEqual(all.shown.map(m => m.id || m.notice), ['m1']);
});
test('event lines wait for the video like any other message', () => {
  const all = harness({ settings: { chatDelay: 10 } }), socket = all.connect();
  all.event(socket, ROOM, EV('SubscriptionEvent'), { username: 'Mira', months: 1 });
  assert.equal(all.shown.length, 0);
  all.tick(10000);
  assert.deepEqual(notices(all), ['Mira subscribed']);
});
test('events with missing names are dropped, not shown half-empty', () => {
  const all = harness(), socket = all.connect();
  all.event(socket, ROOM, EV('SubscriptionEvent'), {});
  all.event(socket, 'chatroom_1', 'GiftedSubscriptionsEvent', { gifted_usernames: [] });
  all.event(socket, 'chatrooms.1', EV('StreamHostedEvent'), { message: {} });
  assert.equal(all.shown.length, 0);
});
