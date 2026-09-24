'use strict';
/* OLED burn-in guard.
   Static bright pixels can burn into an OLED over time. When nothing has moved
   for a while and the screen is showing something static (an idle message or a
   paused frame), we heavily dim the whole panel so nothing stays lit and bright.
   Any remote or pointer activity wakes it back up. */
var saver = { on: false, timer: null, staticSince: 0 };
function markInput() {
  state.lastInput = Date.now();
  if (saver.on) wakeSaver();
  touchSettings();
}
function isStaticScreen() {
  var v = document.getElementById('video');
  // A full-screen panel is static chrome — its green frame, header chips and card edges do
  // not move whatever plays behind it, and that frame is the largest bright constant in the
  // app. Opening Browse used to pause playback, so a paused video stood in for "nothing is
  // changing"; it no longer does, which left the guard unable to fire over an open panel.
  // The surf list only counts when it is the persistent stream-end one; normally it
  // auto-hides in seconds.
  if (browse.open || cats.open || vods.open || (chpop.open && chpop.persistent)) return true;
  // a VOD is moving video too, so only an idle screen or a paused frame counts
  return (!state.current && !state.vod) || (v && v.paused);
}
/* Runs once a second, not on a lazy beat. staticSince is stamped on the first tick that
   sees a still screen, so the tick period lands on top of the setting twice over — once
   waiting to notice, once waiting to fire. At 20s that made a 1-minute guard arrive at
   about 80. The body is a handful of flag reads, so a 1s beat is free; keep it there. */
function checkSaver() {
  if (!state.ready || !settings.saverMin) return;   // 0 = guard off
  // A screen that starts moving again ends the guard by itself, without waiting for a
  // keypress. Auto-advance is the case this exists for: a stream ends while you are
  // away, the guard fires during the gap where the video is paused, and the next
  // channel then plays on behind a dim overlay nobody is there to dismiss.
  if (!isStaticScreen()) {
    saver.staticSince = 0;
    if (saver.on) wakeSaver();
    return;
  }
  if (saver.on) return;
  var now = Date.now();
  if (!saver.staticSince) saver.staticSince = now;
  if (state.notifyCurrent) return;
  // Both clocks have to run out: no input, and the screen actually still for that long.
  // So a short pause between two streams cannot trip the guard on its way past.
  var idle = settings.saverMin * 60000;
  if (now - state.lastInput >= idle && now - saver.staticSince >= idle) showSaver();
}
function showSaver() { saver.on = true; document.getElementById('saver').className = 'on'; }
function wakeSaver() { saver.on = false; document.getElementById('saver').className = ''; }

