'use strict';
/* Chat replay for past videos (and for a live stream that has been rewound).

   Kick keeps every room's messages and hands them out five seconds at a time,
   addressed by wall-clock time. A recording knows the wall-clock time of the frame
   on screen (each segment carries it), so the messages can be shown at the moment
   they were sent, in step with the picture. A seek starts over at the new
   position with the last few seconds filled in.

   Nothing here touches the live socket: syncChat sends a past video this way and
   a live stream the other. */
var REPLAY_WINDOW_MS = 5000;     // how much chat one request returns
var REPLAY_PREFILL_MS = 10000;   // how far back to fill when replay starts or jumps
var REPLAY_AHEAD_MS = 4000;      // ask for the next window this long before the picture reaches it
var REPLAY_TICK_MS = 500;
var REPLAY_JUMP_MS = 3000;       // further than this from where playback should be: a seek
var REPLAY_RETRY_MS = 2000;
var REPLAY_MAX_FAILS = 3;        // then the window is skipped: a gap beats a replay that stops
// pending: messages fetched but not reached yet, oldest first. token: bumped on every
// start, jump and stop, so an answer for an earlier position is recognised and dropped.
var chatReplay = { on: false, slug: '', channelId: 0, nextMs: 0, lastPos: 0, lastAt: 0,
                   pending: [], load: null, fails: 0, retryAt: 0, timer: null, token: 0 };

// Wall-clock time of the frame on screen, or 0 while that cannot be told.
function vodWallMs() {
  var v = state.vod, video = document.getElementById('video');
  if (!v || !video) return 0;
  var date = null;
  try { date = state.hls && state.hls.playingDate; } catch (e) {}
  var exact = date && date.getTime ? date.getTime() : 0;
  if (exact > 0) return exact;
  // Before the player reports a segment time, the listed start is a few seconds off at worst.
  return v.startMs > 0 ? v.startMs + (video.currentTime || 0) * 1000 : 0;
}
function cancelReplayLoad() {
  if (chatReplay.load) { cancelChatLoad(chatReplay.load); chatReplay.load = null; }
}
function stopChatReplay() {
  var r = chatReplay;
  if (!r.on) return;
  r.on = false; r.token++;
  cancelReplayLoad();
  if (r.timer !== null) { clearInterval(r.timer); r.timer = null; }
  r.pending = []; r.slug = ''; r.channelId = 0;
  hideChatOverlay(); clearChat();
}
// Bring the replay into line with the setting and the video (see syncChat).
function syncChatReplay() {
  var v = state.vod, r = chatReplay;
  if (!v || !settings.chat) { stopChatReplay(); return; }
  if (r.on && r.slug === v.slug) { showChatOverlay(); return; }
  stopChatReplay();
  r.on = true; r.slug = v.slug; r.channelId = 0; r.token++;
  r.lastAt = 0; r.lastPos = 0; r.nextMs = 0; r.fails = 0; r.retryAt = 0;
  clearChat(); showChatOverlay(); useSevenTv();
  ChatWindow.status('connected', 'Replay');
  r.timer = setInterval(tickChatReplay, REPLAY_TICK_MS);
  var known = state.channels[v.slug];
  if (known && known.channelId) { r.channelId = known.channelId; return; }
  // A video from a streamer who is not in the list: the room is addressed by channel id.
  var token = r.token, slug = v.slug;
  apiGet(slug, function (err, raw) {
    if (token !== r.token || !r.on) return;
    var c = !err && raw && raw.id ? normalize(slug, raw) : null;
    if (!c || !c.channelId) {
      // The setting is left alone: this is a lookup that failed, not the viewer
      // switching chat off, and the next sync (Green, coming back to the app) tries again.
      stopChatReplay();
      toast('Chat is unavailable for this video');
      return;
    }
    var entry = state.channels[slug];
    if (entry) { entry.channelId = c.channelId; entry.userId = c.userId; }
    else state.channels[slug] = c;
    r.channelId = c.channelId;
    useSevenTv();                                 // the owner id is known now
  }, { priority: 2 });
}
// The picture is somewhere new: drop what was queued for the old position.
function jumpChatReplay(pos) {
  var r = chatReplay;
  r.token++;
  cancelReplayLoad();
  r.pending = []; r.fails = 0; r.retryAt = 0;
  clearChat();
  // Kick's timestamps are whole seconds, so windows start on one.
  r.nextMs = Math.floor((pos - REPLAY_PREFILL_MS) / 1000) * 1000;
}
function tickChatReplay() {
  var r = chatReplay, v = state.vod;
  if (!r.on || !r.channelId || !v || v.slug !== r.slug) return;
  var video = document.getElementById('video');
  // Until the resume seek has landed the position is not where the viewer will be.
  if (!video || video.seeking || video.readyState < 2 || (v.resumeAt > 0 && !v.resumeApplied)) return;
  var pos = vodWallMs(), now = Date.now();
  if (!pos) return;
  var expected = r.lastPos + (now - r.lastAt) * (video.playbackRate || 1);
  if (!r.lastAt || pos < r.lastPos - 1000 || pos > expected + REPLAY_JUMP_MS) jumpChatReplay(pos);
  r.lastPos = pos; r.lastAt = now;
  while (r.pending.length && r.pending[0].at <= pos) {
    var item = r.pending.shift();
    addChatMessage(item.data, item.at);
  }
  if (!r.load && now >= r.retryAt && r.nextMs <= pos + REPLAY_AHEAD_MS) loadReplayWindow();
}
function loadReplayWindow() {
  var r = chatReplay, start = r.nextMs, token = r.token;
  var path = '/api/v2/channels/' + r.channelId + '/messages?start_time=' + encodeURIComponent(new Date(start).toISOString());
  r.load = serviceGet(path, function (err, body) {
    if (token !== r.token || !r.on) return;
    r.load = null;
    var list = !err && body && body.data && body.data.messages;
    if (!Array.isArray(list)) {
      r.fails++;
      if (r.fails < REPLAY_MAX_FAILS) { r.retryAt = Date.now() + REPLAY_RETRY_MS; return; }
      list = [];
    }
    r.fails = 0; r.retryAt = 0;
    r.nextMs = start + REPLAY_WINDOW_MS;
    queueReplayMessages(list);
  }, { priority: 2 });
}
function queueReplayMessages(list) {
  var r = chatReplay, added = false;
  for (var i = 0; i < list.length; i++) {
    var m = chatMessageFromHistory(list[i]);
    var at = m ? Date.parse(m.created_at) : NaN;
    if (!isFinite(at)) continue;
    var lines = chatLinesFor(m);
    for (var j = 0; j < lines.length; j++) { r.pending.push({ data: lines[j], at: at }); added = true; }
  }
  // Kick does not promise an order inside a window.
  if (added) r.pending.sort(function (a, b) { return a.at - b.at; });
}
