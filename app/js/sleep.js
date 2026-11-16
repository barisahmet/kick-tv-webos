'use strict';
/* Sleep timer (Settings). After the chosen time playback stops and the whole
   screen is dimmed, so a TV left on overnight is neither playing nor showing a
   bright still picture. An app cannot switch the TV itself off; with nothing
   playing, the TV's own screen saver and auto power-off take it from there.

   The last minute shows a warning, and any button then means someone is still
   watching: the timer is turned off and that press does nothing else. The timer
   is never saved, so the app always starts with it off. */
var SLEEP_WARN_MS = 60000;
var sleepTimer = { deadline: 0, timer: null, warning: false };
// Minutes left, rounded up so the last minute never reads zero. 0: the timer is off.
function sleepLeftMin() {
  return sleepTimer.deadline ? Math.max(1, Math.ceil((sleepTimer.deadline - Date.now()) / 60000)) : 0;
}
function stopSleepTimer() {
  if (sleepTimer.timer !== null) { clearInterval(sleepTimer.timer); sleepTimer.timer = null; }
  sleepTimer.deadline = 0;
  settings.sleepMin = 0;
  if (sleepTimer.warning) { sleepTimer.warning = false; renderSleepWarning(0); }
}
// minutes: how long from now; 0 (or anything that is not a time) turns it off.
function setSleepTimer(minutes) {
  stopSleepTimer();
  minutes = Math.round(+minutes);
  if (!(minutes > 0) || !isFinite(minutes)) return;
  settings.sleepMin = minutes;
  sleepTimer.deadline = Date.now() + minutes * 60000;
  sleepTimer.timer = setInterval(tickSleepTimer, 1000);
}
function tickSleepTimer() {
  if (!sleepTimer.deadline) return;
  var left = sleepTimer.deadline - Date.now();
  if (left <= 0) { fireSleepTimer(); return; }
  if (left > SLEEP_WARN_MS) return;
  sleepTimer.warning = true;
  renderSleepWarning(Math.ceil(left / 1000));
}
function fireSleepTimer() {
  stopSleepTimer();
  if (settings.open) renderSettings();              // the row reads Off again
  // Another app is in front: whatever is on screen is not ours to stop or dim.
  if (document.hidden) return;
  if (state.current || state.vod) returnToIdle();   // saves a past video's position on the way
  showSaver();                                      // dark until a button is pressed
}
// Called for every button press. True while the warning is up: the press was the
// answer to it, and must not also do its usual job.
function sleepKeepWatching() {
  if (!sleepTimer.warning) return false;
  stopSleepTimer();
  if (settings.open) renderSettings();
  toast('Sleep timer off');
  return true;
}
function renderSleepWarning(seconds) {
  var el = document.getElementById('sleepwarn');
  if (!el) return;
  if (!(seconds > 0)) { if (el.className !== 'hidden') el.className = 'hidden'; return; }
  changedText(el, 'Sleep timer: stopping in ' + seconds + (seconds === 1 ? ' second' : ' seconds') +
    '. Press any button to keep watching.');
  el.style.filter = popupDimFilter();
  if (el.className !== '') el.className = '';
}
