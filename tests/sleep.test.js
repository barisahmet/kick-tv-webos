const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./chat-harness.js');

/* Sleep timer: stop playback and dim the screen after a set time, with a warning
   in the last minute that any button answers. */
const MIN = 60000;
const last = list => list[list.length - 1];

test('when the time is up playback stops and the screen is dimmed', () => {
  const all = harness();
  all.h.setSleepTimer(30);
  assert.equal(all.h.sleepLeftMin(), 30);
  all.tick(29 * MIN);
  assert.equal(all.idled.length, 0);
  assert.equal(all.h.sleepLeftMin(), 1);
  all.tick(MIN);
  assert.equal(all.idled.length, 1);
  assert.equal(all.dimmed.length, 1);
  assert.equal(all.h.sleepLeftMin(), 0);
  assert.equal(all.h.settings.sleepMin, 0, 'the setting reads Off again');
  all.tick(60 * MIN);
  assert.equal(all.idled.length, 1, 'it fires once');
});
test('a past video is stopped the same way as a live stream', () => {
  const all = harness({ state: { current: null, vod: { slug: 'alpha' } } });
  all.h.setSleepTimer(15);
  all.tick(15 * MIN);
  assert.equal(all.idled.length, 1);
});
test('with nothing playing the screen is still dimmed', () => {
  const all = harness({ state: { current: null, vod: null } });
  all.h.setSleepTimer(15);
  all.tick(15 * MIN);
  assert.equal(all.idled.length, 0);
  assert.equal(all.dimmed.length, 1);
});
test('the last minute shows a warning that counts down', () => {
  const all = harness();
  all.h.setSleepTimer(15);
  all.tick(14 * MIN - 1000);
  assert.equal(all.warnings.filter(s => s > 0).length, 0, 'not before the last minute');
  all.tick(1000);
  assert.equal(last(all.warnings), 60);
  all.tick(15000);
  assert.equal(last(all.warnings), 45);
  all.tick(45000);
  assert.equal(last(all.warnings), 0, 'and it is taken down when the timer fires');
});
test('any button during the warning keeps the stream on and turns the timer off', () => {
  const all = harness();
  all.h.setSleepTimer(15);
  all.tick(14 * MIN + 20000);
  assert.equal(all.h.sleepKeepWatching(), true, 'the press is used up by the warning');
  assert.deepEqual(all.toasts, ['Sleep timer off']);
  assert.equal(last(all.warnings), 0);
  all.tick(10 * MIN);
  assert.equal(all.idled.length, 0);
  assert.equal(all.h.settings.sleepMin, 0);
});
test('before the warning a button press is just a button press', () => {
  const all = harness();
  assert.equal(all.h.sleepKeepWatching(), false, 'timer off');
  all.h.setSleepTimer(15);
  all.tick(5 * MIN);
  assert.equal(all.h.sleepKeepWatching(), false, 'timer running, no warning yet');
  assert.equal(all.h.sleepLeftMin(), 10);
});
test('setting it again starts over, and Off cancels it', () => {
  const all = harness();
  all.h.setSleepTimer(30);
  all.tick(20 * MIN);
  all.h.setSleepTimer(30);
  all.tick(20 * MIN);
  assert.equal(all.idled.length, 0);
  all.h.setSleepTimer(0);
  assert.equal(all.h.sleepLeftMin(), 0);
  all.tick(60 * MIN);
  assert.equal(all.idled.length, 0);
});
test('changing the time during the warning takes the warning down', () => {
  const all = harness();
  all.h.setSleepTimer(15);
  all.tick(14 * MIN + 5000);
  all.h.setSleepTimer(45);
  assert.equal(last(all.warnings), 0);
  assert.equal(all.h.sleepKeepWatching(), false);
});
test('minutes left round up, so the last minute never reads zero', () => {
  const all = harness();
  all.h.setSleepTimer(15);
  all.tick(30000);
  assert.equal(all.h.sleepLeftMin(), 15);
  all.tick(31000);
  assert.equal(all.h.sleepLeftMin(), 14);
  all.tick(13 * MIN + 58000);
  assert.equal(all.h.sleepLeftMin(), 1);
});
test('values that are not a sensible time turn it off', () => {
  const all = harness();
  for (const bad of [-5, NaN, 'soon', null, undefined, Infinity]) {
    all.h.setSleepTimer(15); all.h.setSleepTimer(bad);
    assert.equal(all.h.sleepLeftMin(), 0, String(bad));
  }
});
test('if another app is in front when the time is up, nothing of ours is touched', () => {
  const all = harness();
  all.h.setSleepTimer(15);
  all.h.document.hidden = true;
  all.tick(15 * MIN);
  assert.equal(all.idled.length, 0);
  assert.equal(all.dimmed.length, 0);
  assert.equal(all.h.sleepLeftMin(), 0);
});
