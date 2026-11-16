'use strict';
/* Raid follow. A streamer can end by sending the audience to another channel
   (a raid; Kick calls it a host). Kick announces it to every viewer on the
   channel's own Pusher channel, and its website then moves them after a short
   countdown. This does the same: a small prompt counts down and then switches,
   with Stay (or Back) to keep watching what is on.

   The announcement is real time while the picture trails it, so the countdown is
   stretched by that lag: the streamer's goodbye is still on its way to the screen.
   If the stream ends first, the raid is followed there and then instead of the
   app going to the idle screen (advanceOrIdle asks followRaidFrom). */
var RAID_MIN_SEC = 10, RAID_MAX_SEC = 30;
var RAID_REPEAT_MS = 10 * 60000;   // the same announcement again within this long is a repeat, not a new raid
// focus: 0 Go now, 1 Stay. seenKey/seenAt: the last announcement that was dealt with.
var raid = { open: false, from: '', slug: '', title: '', deadline: 0, timer: null, focus: 1, seenKey: '', seenAt: 0 };
function raidLeftSec() {
  return raid.open ? Math.max(0, Math.ceil((raid.deadline - Date.now()) / 1000)) : 0;
}
// d is Kick's ChatMoveToSupportedChannelEvent; d.hosted is the channel being raided.
function onRaidOut(d) {
  var hosted = d && d.hosted, slug = hosted && hosted.slug, from = state.current;
  if (!settings.raidFollow || !from || state.vod || document.hidden) return;
  if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(slug) || slug === from) return;
  // Kick can send the announcement more than once. Whatever became of the first one
  // (offered, declined, or only announced) stands; it is not offered or said again.
  var key = from + '>' + slug, now = Date.now();
  if (raid.seenKey === key && now - raid.seenAt < RAID_REPEAT_MS) return;
  raid.seenKey = key; raid.seenAt = now;
  var fromName = (state.channels[from] && state.channels[from].name) || from;
  var title = fromName + ' is raiding ' + (chatName(hosted.username) || slug);
  // A menu on screen (the channel list included) belongs to the viewer: say what
  // happened and leave it at that.
  if (state.mode !== 'player' || state.sidebarOpen || anyPanelOpen()) { toast(title); return; }
  cancelRaid();
  var lag = liveLatencySec();
  var wait = Math.min(RAID_MAX_SEC, Math.max(RAID_MIN_SEC, Math.round(isFinite(lag) ? lag : 0) + 5));
  raid.open = true; raid.from = from; raid.slug = slug; raid.title = title; raid.focus = 1;
  raid.deadline = now + wait * 1000;
  raid.timer = setInterval(tickRaid, 250);
  renderRaid();
}
function cancelRaid() {
  if (raid.timer !== null) { clearInterval(raid.timer); raid.timer = null; }
  if (!raid.open) return;
  raid.open = false; raid.from = ''; raid.slug = '';
  renderRaid();
}
function tickRaid() {
  if (!raid.open) return;
  if (state.current !== raid.from || state.vod || !settings.raidFollow || document.hidden) { cancelRaid(); return; }
  if (!raidLeftSec()) followRaid(); else renderRaid();
}
function followRaid() {
  if (!raid.open) return;
  var slug = raid.slug;
  cancelRaid();
  play(slug);
}
// The stream on `slug` has just ended. If its raid was still counting down, go
// there now and say so; the caller then skips its own "stream ended" handling.
function followRaidFrom(slug) {
  if (!raid.open || raid.from !== slug) return false;
  followRaid();
  return true;
}
function raidKey(k) {
  if (k === KEY.BACK || k === KEY.STOP) cancelRaid();
  else if (k === KEY.LEFT || k === KEY.RIGHT) { raid.focus = k === KEY.LEFT ? 0 : 1; renderRaid(); }
  else if (k === KEY.OK) { if (raid.focus === 0) followRaid(); else cancelRaid(); }
}
function renderRaid() {
  var box = document.getElementById('raid-next');
  if (!box) return;
  var cls = raid.open ? '' : 'hidden';
  if (box.className !== cls) box.className = cls;
  if (!raid.open) return;
  var left = raidLeftSec();
  changedText(document.getElementById('raid-next-count'), 'Following in ' + left + (left === 1 ? ' second' : ' seconds'));
  changedText(document.getElementById('raid-next-title'), raid.title);
  document.getElementById('raid-next-go').classList.toggle('focused', raid.focus === 0);
  document.getElementById('raid-next-stay').classList.toggle('focused', raid.focus === 1);
}
(function wireRaid() {
  var go = document.getElementById('raid-next-go'), stay = document.getElementById('raid-next-stay');
  if (!go || !stay) return;
  go.addEventListener('click', function (e) { e.stopPropagation(); followRaid(); });
  stay.addEventListener('click', function (e) { e.stopPropagation(); cancelRaid(); });
})();
