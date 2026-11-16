const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./chat-harness.js');

/* Chat replay for past videos. Kick keeps every room's messages and serves them
   five seconds at a time, by wall-clock time. The video's position maps onto that
   clock, so the chat can be replayed in step with the picture. */
const T0 = Date.UTC(2026, 10, 14, 22, 41, 45);        // when the synthetic recording began
const iso = ms => new Date(ms).toISOString();
const windowsOf = all => all.gets.filter(g => /\/api\/v2\/channels\/42\/messages\?start_time=/.test(g.path));
const startOf = get => Date.parse(decodeURIComponent(get.path.split('start_time=')[1]));
const offsets = all => windowsOf(all).map(g => (startOf(g) - T0) / 1000);

function vodHarness(options = {}) {
  const all = harness({ state: Object.assign({ current: null,
    vod: { slug: 'alpha', startMs: T0, resumeAt: 0, resumeApplied: true } }, options.state), settings: options.settings });
  // Play the video for `sec` seconds of wall time, half a second at a time.
  all.playFor = (sec) => {
    for (let i = 0; i < sec * 2; i++) {
      if (!all.video.paused) all.video.currentTime += 0.5 * all.video.playbackRate;
      all.tick(500);
    }
  };
  all.at = (sec, id, user = 5, text = 'hi') => all.message(id, user, text, { created_at: iso(T0 + sec * 1000) });
  // Answer the oldest unanswered window with these messages.
  all.answer = (messages = []) => {
    const get = windowsOf(all).find(g => !g.answered && !g.cancelled);
    get.answered = true; get.cb(null, { data: { messages, cursor: '1', pinned_message: null } });
    return get;
  };
  return all;
}

test('a past video replays its chat: the last ten seconds at once, the rest as the picture reaches it', () => {
  const all = vodHarness();
  all.video.currentTime = 100;
  all.h.syncChat();
  all.tick(500);
  assert.deepEqual(offsets(all), [90]);
  all.answer([all.at(97, 'b'), all.at(92, 'a')]);
  all.tick(500);
  assert.deepEqual(all.shown.map(m => m.id), ['a', 'b'], 'already behind the picture: shown, oldest first');
  assert.deepEqual(offsets(all), [90, 95]);
  all.answer([]);
  all.tick(500);
  assert.deepEqual(offsets(all), [90, 95, 100]);
  all.answer([all.at(101, 'c'), all.at(104, 'd')]);
  all.tick(500);
  assert.deepEqual(all.shown.map(m => m.id), ['a', 'b'], 'the picture has not reached them yet');
  all.video.currentTime = 101.2; all.tick(500);
  assert.deepEqual(all.shown.map(m => m.id), ['a', 'b', 'c']);
  all.video.currentTime = 104; all.tick(500);
  assert.deepEqual(all.shown.map(m => m.id), ['a', 'b', 'c', 'd']);
  assert.equal(all.shown[3].shownAt, T0 + 104000, 'timestamps show when it was said');
});
test('windows follow one another without gaps or overlaps while the video plays', () => {
  const all = vodHarness();
  all.video.currentTime = 60;
  all.h.syncChat();
  for (let i = 0; i < 40; i++) { all.playFor(0.5); while (windowsOf(all).some(g => !g.answered)) all.answer([]); }
  const seen = offsets(all);
  assert.equal(seen[0], 50);
  seen.forEach((value, i) => { if (i) assert.equal(value - seen[i - 1], 5); });
  assert.ok(seen[seen.length - 1] >= 80 && seen[seen.length - 1] <= 90, 'no further ahead than it needs: ' + seen[seen.length - 1]);
});
test('only one window is asked for at a time', () => {
  const all = vodHarness();
  all.video.currentTime = 100;
  all.h.syncChat();
  all.playFor(10);
  assert.equal(windowsOf(all).length, 1);
});
test('a paused video stops asking once it has what it needs', () => {
  const all = vodHarness();
  all.video.currentTime = 100;
  all.h.syncChat();
  all.video.paused = true;
  for (let i = 0; i < 20; i++) { all.tick(500); while (windowsOf(all).some(g => !g.answered)) all.answer([]); }
  const count = windowsOf(all).length;
  all.playFor(60);
  assert.equal(windowsOf(all).length, count);
});
test('at double speed the chat keeps up with the picture', () => {
  const all = vodHarness();
  all.video.currentTime = 100; all.video.playbackRate = 2;
  all.h.syncChat();
  for (let i = 0; i < 40; i++) {
    all.playFor(0.5);
    while (windowsOf(all).some(g => !g.answered)) { const g = windowsOf(all).find(x => !x.answered); const sec = (startOf(g) - T0) / 1000; all.answer([all.at(sec + 1, 'm' + sec)]); }
  }
  assert.equal(all.video.currentTime, 140);
  const reached = offsets(all).filter(sec => sec + 1 <= 140).map(sec => 'm' + sec);
  assert.equal(reached.length, 10);
  assert.deepEqual(all.shown.map(m => m.id), reached, 'every window the picture passed, in order, none dropped by the speed');
});
test('seeking clears the chat and replays from the new position', () => {
  const all = vodHarness();
  all.video.currentTime = 100;
  all.h.syncChat();
  all.tick(500);
  all.answer([all.at(95, 'old')]);
  all.tick(500);
  const stale = windowsOf(all)[1];
  all.video.currentTime = 4000; all.tick(500);
  assert.equal(all.shown.length, 0);
  assert.equal(stale.cancelled, true);
  stale.cb(null, { data: { messages: [all.at(99, 'from before the seek')] } });
  all.tick(500);
  assert.equal(all.shown.length, 0, 'an answer for the old position is ignored');
  assert.equal(offsets(all)[offsets(all).length - 1], 3990);
  all.video.currentTime = 30; all.tick(500);          // and backwards
  assert.equal(offsets(all)[offsets(all).length - 1], 20);
});
test('the first seconds of a video ask for chat from its very start, not from before it', () => {
  const all = vodHarness();
  all.video.currentTime = 2;
  all.h.syncChat();
  all.tick(500);
  assert.deepEqual(offsets(all), [-8], 'a window before the stream began is harmless: Kick answers it empty');
});
test('a window that keeps failing is skipped after three tries, so one bad answer cannot stop the replay', () => {
  const all = vodHarness();
  all.video.currentTime = 100;
  all.h.syncChat();
  all.tick(500);
  for (let i = 0; i < 3; i++) {
    const get = windowsOf(all).find(g => !g.answered); get.answered = true; get.cb('timeout');
    all.tick(2500);
  }
  assert.deepEqual(offsets(all), [90, 90, 90, 95]);
});
test('the segment timestamps are used when the player has them: they are exact, the listed start is not', () => {
  const all = vodHarness();
  all.video.currentTime = 100;
  all.h.state.hls = { get playingDate() { return new Date(T0 + 3000 + all.video.currentTime * 1000); } };
  all.h.syncChat();
  all.tick(500);
  assert.deepEqual(offsets(all), [93]);
});
test('nothing is asked for until the video has gone to its resume point', () => {
  const all = vodHarness({ state: { current: null, vod: { slug: 'alpha', startMs: T0, resumeAt: 600, resumeApplied: false } } });
  all.h.syncChat();
  all.tick(2000);
  assert.equal(windowsOf(all).length, 0);
  all.h.state.vod.resumeApplied = true; all.video.currentTime = 600;
  all.tick(500);
  assert.deepEqual(offsets(all), [590]);
});
test('a video without a known start time has no replay rather than a wrong one', () => {
  const all = vodHarness({ state: { current: null, vod: { slug: 'alpha', startMs: 0, resumeAt: 0, resumeApplied: true } } });
  all.video.currentTime = 100;
  all.h.syncChat();
  all.tick(5000);
  assert.equal(windowsOf(all).length, 0);
});
test('a streamer whose channel id is not known yet is looked up first', () => {
  const all = vodHarness({ state: { current: null, vod: { slug: 'gamma', startMs: T0, resumeAt: 0, resumeApplied: true } } });
  all.video.currentTime = 100;
  all.h.syncChat();
  all.tick(1000);
  const lookup = all.gets.find(g => g.path === 'channel:gamma');
  assert.ok(lookup);
  assert.equal(all.gets.length, 1, 'no chat request before the id is known');
  lookup.cb(null, { id: 77, user: { id: 9 }, chatroom: { id: 70 } });
  all.tick(500);
  assert.match(all.gets[1].path, /^\/api\/v2\/channels\/77\/messages\?start_time=/);
  assert.equal(all.h.state.channels.gamma.channelId, 77);
});
test('a lookup that fails says chat is unavailable and leaves the video alone', () => {
  const all = vodHarness({ state: { current: null, vod: { slug: 'gamma', startMs: T0, resumeAt: 0, resumeApplied: true } } });
  all.h.syncChat();
  all.gets.find(g => g.path === 'channel:gamma').cb(404);
  all.tick(5000);
  assert.equal(all.gets.length, 1);
  assert.deepEqual(all.toasts, ['Chat is unavailable for this video']);
  assert.equal(all.h.settings.chat, true, 'a lookup that failed once is not the viewer switching chat off');
  assert.equal(all.saves.length, 0, 'and nothing is written to the streamer\'s saved chat options');
  all.h.syncChat();
  assert.equal(all.gets.filter(g => g.path === 'channel:gamma').length, 2, 'asking for chat again tries the lookup again');
});
test('turning chat off, or leaving the video, stops the replay', () => {
  const all = vodHarness();
  all.video.currentTime = 100;
  all.h.syncChat();
  all.tick(500);
  const pending = windowsOf(all)[0];
  all.h.settings.chat = false; all.h.syncChat();
  assert.equal(pending.cancelled, true);
  pending.cb(null, { data: { messages: [all.at(95, 'late')] } });
  all.playFor(30);
  assert.equal(windowsOf(all).length, 1);
  assert.equal(all.shown.length, 0);
  all.h.settings.chat = true; all.h.syncChat(); all.tick(500);
  assert.equal(windowsOf(all).length, 2, 'and back on starts it again');
  all.h.disconnectChat();
  all.playFor(30);
  assert.equal(windowsOf(all).length, 2);
});
test('a past video never opens the live chat socket', () => {
  const all = vodHarness({ settings: { raidFollow: true } });
  all.h.syncChat();
  assert.equal(all.requests.length, 0);
});
test('renewals in the replay get their line, and history\'s text-encoded details are read', () => {
  const all = vodHarness();
  all.video.currentTime = 100;
  all.h.syncChat();
  all.tick(500);
  all.answer([all.at(95, 'c1', 5, 'still here!'), Object.assign(all.at(96, 'c2', 6, '🎉'), { type: 'celebration',
    metadata: JSON.stringify({ celebration: { type: 'subscription_renewed', total_months: 2 } }) })]);
  all.tick(500);
  assert.deepEqual(all.shown.map(m => m.notice || m.id), ['c1', 'user6 resubscribed for 2 months']);
});
test('chat can be switched on during a past video, and not on the idle screen', () => {
  const all = vodHarness();
  assert.equal(all.h.chatCanTurnOn(), true);
  all.h.state.vod = null;
  assert.equal(all.h.chatCanTurnOn(), false);
  assert.deepEqual(all.toasts, ['Chat needs a stream or a past video']);
});
