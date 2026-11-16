/* The sleep timer as the viewer meets it: a Settings row, a warning in the last
   minute, and a dark idle screen when it runs out. */
window.runSleepTests = async function (assert) {
  function key(k) { document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })); }
  function sleepRow() {
    var rows = document.querySelectorAll('#settings-list .srow');
    for (var i = 0; i < rows.length; i++) if (rows[i].querySelector('.slabel').textContent === 'Sleep timer') return rows[i];
    return null;
  }
  function pill() { return sleepRow().querySelector('.spill').textContent; }
  function focusSleepRow() {
    for (var i = 0; i < settings.items.length; i++) if (settings.items[i].key === 'sleepMin') settings.focus = i;
    applySettingsFocus();
  }
  function warningShown() { var el = document.getElementById('sleepwarn'); return el.className.indexOf('hidden') === -1 && el.offsetHeight > 0; }
  try {
    openSettings();
    assert(!!sleepRow() && pill() === 'Off', 'Settings has a Sleep timer row, off to begin with');
    focusSleepRow();
    key(KEY.RIGHT);
    assert(pill() === '15 min' && sleepLeftMin() === 15, 'Right sets 15 minutes and starts the timer');
    key(KEY.RIGHT);
    assert(pill() === '30 min' && sleepLeftMin() === 30, 'again for 30');
    key(KEY.LEFT); key(KEY.LEFT);
    assert(pill() === 'Off' && sleepLeftMin() === 0, 'Left steps back down to Off, which cancels it');
    key(KEY.RIGHT); key(KEY.RIGHT);
    closeSettings();

    sleepTimer.deadline -= 3 * 60000 - 500;          // a little under three minutes go by
    openSettings();
    assert(pill() === '28 min', 'reopening Settings shows the minutes left: ' + pill());
    focusSleepRow();
    key(KEY.RIGHT);
    assert(pill() === '30 min' && sleepLeftMin() === 30, 'Right from between two stops goes to the next stop up: ' + pill());
    sleepTimer.deadline -= 2 * 60000 - 500; closeSettings(); openSettings(); focusSleepRow();
    key(KEY.LEFT);
    assert(pill() === '15 min' && sleepLeftMin() === 15, 'Left from between two stops goes to the next stop down: ' + pill());
    key(KEY.RIGHT); key(KEY.RIGHT); key(KEY.RIGHT);
    assert(pill() === '60 min', 'and on a stop each press is one stop: ' + pill());
    closeSettings();
    assert(String(fixtureStore['kicktv.settings'] || '').indexOf('sleepMin') === -1, 'the timer is not saved with the settings');

    assert(!warningShown(), 'no warning while there is time left');
    sleepTimer.deadline = Date.now() + 30000; tickSleepTimer();
    assert(warningShown() && /stopping in (30|29) seconds\. Press any button to keep watching\./.test(document.getElementById('sleepwarn').textContent), 'the last minute shows a warning with the seconds left');
    key(KEY.RED);
    assert(!warningShown() && sleepLeftMin() === 0, 'a button press answers the warning and turns the timer off');
    assert(!settings.open, 'and is not also treated as its usual command (Red opens Settings)');
    assert(document.getElementById('toast').textContent === 'Sleep timer off', 'saying so');
    key(KEY.RED);
    assert(settings.open, 'the next press works as normal');
    closeSettings();

    // The pointer is a button too, wherever it lands.
    setSleepTimer(15); sleepTimer.deadline = Date.now() + 30000; tickSleepTimer();
    document.getElementById('player').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    assert(!warningShown() && sleepLeftMin() === 0, 'a pointer click answers the warning');
    setSleepTimer(15); sleepTimer.deadline = Date.now() + 30000; tickSleepTimer();
    document.getElementById('chat').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    assert(!warningShown(), 'even inside the chat window, which keeps its clicks to itself');
    setSleepTimer(15); sleepTimer.deadline = Date.now() + 30000; tickSleepTimer();
    document.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
    assert(!warningShown(), 'and so does the wheel');
    setSleepTimer(15); sleepTimer.deadline = Date.now() + 30000; tickSleepTimer();
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    assert(warningShown(), 'merely moving the pointer does not');
    setSleepTimer(0);

    setSleepTimer(15);
    sleepTimer.deadline = Date.now() - 1; tickSleepTimer();
    assert(state.current === null && !state.vod, 'when it runs out the stream stops');
    assert(saver.on && document.getElementById('saver').className === 'on', 'and the screen goes dark');
    assert(sleepLeftMin() === 0 && sleepTimer.timer === null, 'the timer is finished');
    key(KEY.OK);
    assert(!saver.on, 'any button brings the screen back');
  } finally {
    setSleepTimer(0); wakeSaver();
    if (settings.open) closeSettings();
    state.current = 'alpha';
  }
};
