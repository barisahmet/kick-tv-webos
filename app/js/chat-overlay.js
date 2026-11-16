'use strict';
/* Buffering spinner (live and VOD) and VOD play/pause button */
var spinnerOn = false;
// A rebuffer that resolves in a couple of hundred milliseconds is invisible if we
// keep quiet, and reads as a glitch if we flash a spinner at it. Wait a beat first:
// short stalls never show anything, long ones still spin up promptly.
var SPINNER_GRACE_MS = 300;
var spinnerWaitTimer = null;
function showSpinnerSoon() {
  if (spinnerOn || spinnerWaitTimer) return;
  spinnerWaitTimer = setTimeout(function () {
    spinnerWaitTimer = null;
    showSpinner();
  }, SPINNER_GRACE_MS);
}
function cancelSpinnerSoon() {
  if (spinnerWaitTimer) { clearTimeout(spinnerWaitTimer); spinnerWaitTimer = null; }
}
function showSpinner() {
  if (spinnerOn) return;
  if (document.getElementById('pbstatus').className.indexOf('hidden') === -1) return;  // reconnecting banner already up
  spinnerOn = true;
  document.getElementById('spinner').className = '';
  hideVodPlay();
}
function hideSpinner() {
  cancelSpinnerSoon();   // before the guard below: a spinner that is only pending still has to be called off
  if (!spinnerOn) return;
  spinnerOn = false;
  document.getElementById('spinner').className = 'hidden';
  if (state.vod && document.getElementById('overlay').className.indexOf('hidden') === -1) showVodPlay();
}
// Two stacked glyphs cross-fade rather than one path changing its d: Chromium 87
// cannot tween path data, and this swap is the whole acknowledgement for the press,
// so it has to read as movement. An SVG element's className is read-only here —
// setAttribute is the only way to class it.
function vodPlayIcon() {
  var paused = document.getElementById('video').paused;
  document.getElementById('vodplay-play').setAttribute('class', 'vpglyph' + (paused ? ' on' : ''));
  document.getElementById('vodplay-pause').setAttribute('class', 'vpglyph' + (paused ? '' : ' on'));
}
function showVodPlay() {
  if (!state.vod || spinnerOn) return;
  vodPlayIcon();
  document.getElementById('vodplay').className = '';   // un-hide first...
  document.getElementById('vodback').className = '';
  document.getElementById('vodfwd').className = '';
  applyVodCtrlFocus();                                     // ...then restore any focus ring
}
function hideVodPlay() {
  document.getElementById('vodplay').className = 'hidden';
  document.getElementById('vodback').className = 'hidden';
  document.getElementById('vodfwd').className = 'hidden';
}
function toggleVodPlay() {
  if (!state.vod) return;
  if (seekAccum.baseTime !== null) applySeekAccum();   // settle a queued seek before pausing
  var v = document.getElementById('video');
  if (v.paused) playVideo(v); else { try { v.pause(); } catch (e) {} }
  vodPlayIcon();
  showVodOverlay();
}

/* Read-only live chat overlay.
   Kick's chat is delivered over a public Pusher WebSocket, so we can read it
   without any login. We connect straight to Pusher (no Cloudflare in the way,
   unlike the API), subscribe to the channel's chatroom, and print messages.
   Sending would need an account, which this app deliberately does not do.

   The same socket carries the channel's own events, which is how a raid is
   announced (raid.js). So it is open whenever a live channel needs either: chat
   that is switched on, or raid follow. What the events mean is in chat-events.js. */
var CHAT_MAX = 160;                       // bounded scrollback, including off-screen messages
var CHAT_DELAY_MAX = 1000;
var chatPending = [], chatDelayTimer = null;
// viewing: the chat window is open on this socket (the socket can be up without it).
// ready: Pusher has accepted the connection. subs: the Pusher channels asked for.
var chat = { ws: null, room: null, want: false, retry: 0, retryTimer: null,
             activityMs: 120000, activityTimer: null, pongTimer: null,
             connectAttempt: 0, connecting: false, cancelConnect: null,
             viewing: false, ready: false, subs: {} };
/* How long to hold a message. Auto (-1) holds it as long as the picture trails
   real time: every segment carries the wall-clock time it was broadcast, so
   now minus the playing frame's time is exactly how far behind the video is.
   Until the first frame plays that is unknown, and messages wait. */
var CHAT_DELAY_UNKNOWN_MS = 60000;
function chatDelayMs() {
  if (settings.chatDelay >= 0) return settings.chatDelay * 1000;
  if (state.vod) return 0;
  var video = document.getElementById('video'), date = null;
  try { date = state.hls && state.hls.playingDate; } catch (e) {}
  if (!video || !(video.currentTime > 0)) return CHAT_DELAY_UNKNOWN_MS;
  var lag = date && date.getTime ? Date.now() - date.getTime() : liveLatencySec() * 1000;
  return isFinite(lag) ? Math.max(0, Math.min(CHAT_DELAY_UNKNOWN_MS, lag)) : 0;
}
// One timer for the ordered delay queue. Channel changes and closing chat discard
// pending messages, so nothing from the previous room can appear after switching.
// On Auto the lag moves (buffering, a pause, Go live), so the wait is re-judged
// at least every second.
function scheduleChatDelay() {
  if (chatHold !== null || chatDelayTimer !== null || !chatPending.length) return;
  var wait = Math.max(0, chatPending[0].at + chatDelayMs() - Date.now());
  if (settings.chatDelay < 0) wait = Math.min(wait, 1000);
  chatDelayTimer = setTimeout(drainChatDelay, wait);
}
function drainChatDelay() {
  if (chatDelayTimer !== null) clearTimeout(chatDelayTimer);
  chatDelayTimer = null;
  if (chatHold !== null) return;
  var now = Date.now(), count = 0, delay = chatDelayMs();
  while (chatPending.length && chatPending[0].at + delay <= now && count < 40) {
    var item = chatPending.shift(); count++;
    if (chat.want && settings.chat && chat.room === item.room && currentRoomId() === item.room)
      addChatMessage(item.data, item.at);
  }
  scheduleChatDelay();
}
function rescheduleChatDelay() {
  if (chatDelayTimer !== null) clearTimeout(chatDelayTimer);
  chatDelayTimer = null;
  scheduleChatDelay();
}
/* While the room's recent history is on its way nothing is released, so the
   history lands before the live messages that follow it instead of after them.
   The hold is short and ends by itself: a slow or failed lookup must not keep
   chat blank. Auto delay holds messages for longer than this anyway. */
var chatHold = null;
function holdChat(ms) {
  if (chatHold !== null) clearTimeout(chatHold);
  chatHold = setTimeout(function () { chatHold = null; drainChatDelay(); }, ms);
}
function releaseChatHold(quiet) {
  if (chatHold === null) return;
  clearTimeout(chatHold); chatHold = null;
  if (!quiet) drainChatDelay();
}
// Message ids seen lately: a message that arrives live and again in the room's
// history (or in the history after a reconnect) is shown once.
var CHAT_SEEN_MAX = 600;
var chatSeen = Object.create(null), chatSeenOrder = [];
function chatSeenBefore(id) {
  if (typeof id !== 'string' || !id) return false;
  if (chatSeen[id]) return true;
  chatSeen[id] = true; chatSeenOrder.push(id);
  if (chatSeenOrder.length > CHAT_SEEN_MAX) delete chatSeen[chatSeenOrder.shift()];
  return false;
}
function forgetChatSeen() { chatSeen = Object.create(null); chatSeenOrder = []; }
// data is a Kick chat message, or { notice: 'text' } for an event line. `at` is when
// it was sent, for history; live messages count from now.
function queueChatMessage(data, at) {
  if (!data || !(data.sender || data.notice) || !chat.want || !settings.chat) return;
  if (chatSeenBefore(data.id)) return;
  var now = Date.now();
  var item = { data: data, at: at > 0 && at < now ? at : now, room: chat.room };
  // Live messages arrive in order; history lands among them and is slotted in.
  var i = chatPending.length;
  while (i > 0 && chatPending[i - 1].at > item.at) i--;
  chatPending.splice(i, 0, item);
  if (chatPending.length > CHAT_DELAY_MAX) chatPending.shift();
  if (settings.chatDelay === 0 && chatPending.length === 1 && chatDelayTimer === null) drainChatDelay();
  else if (i === 0) rescheduleChatDelay();   // a new head changes when the timer is due
  else scheduleChatDelay();
}
function clearChatDelay() {
  if (chatDelayTimer !== null) clearTimeout(chatDelayTimer);
  chatDelayTimer = null; chatPending = [];
}
// Moderation: take a deleted message (field 'id') or everything a banned chatter
// wrote (field 'uid') out of the queues and off the screen.
function dropChatMessages(field, value) {
  value = String(value);
  function hit(d) { return String(field === 'id' ? d.id : (d.sender && d.sender.id)) === value; }
  chatPending = chatPending.filter(function (item) { return !hit(item.data); });
  chatRenderQueue = chatRenderQueue.filter(function (entry) { return !hit(entry.data); });
  dropChatRows('data-' + field, value);
}
function dropChatRows(attr, value) {
  var box = chatMessagesEl(), row = box.firstChild, next;
  while (row) {
    next = row.nextSibling;
    if (row.getAttribute && row.getAttribute(attr) === value) {
      if (window.UIImages) UIImages.release(row);
      box.removeChild(row);
    }
    row = next;
  }
}
function chatEl() { return document.getElementById('chat'); }
function chatMessagesEl() { return document.getElementById('chat-messages'); }
// Window geometry is independent from message style and survives reconnects.
function chatLightBackground() { return settings.chatBackground === 'white' && settings.chatTransparency <= 50; }
function chatClassBase() {
  var cls = ['csize-' + settings.chatSize,
             'copacity-' + settings.chatOpacity, 'cbg-' + settings.chatBackground];
  if (chatLightBackground()) cls.push('ctheme-light');
  return cls.join(' ');
}
function showChatOverlay() { chatEl().classList.add('on'); applyChatStyle(); }
function hideChatOverlay() { chatEl().className = chatClassBase(); ChatWindow.hide(); }
function applyChatStyle() {
  var el = chatEl();
  var on = el.classList.contains('on'), wasLight = el.classList.contains('ctheme-light');
  el.className = chatClassBase() + (on ? ' on' : '');
  var rgb = settings.chatBackground === 'white' ? '255,255,255' : '0,0,0';
  el.style.backgroundColor = 'rgba(' + rgb + ',' + (100 - settings.chatTransparency) / 100 + ')';
  ChatWindow.show();
  if (wasLight !== chatLightBackground()) {
    var names = chatMessagesEl().querySelectorAll('.cuser');
    for (var i = 0; i < names.length; i++) names[i].style.color = chatNameColor(names[i].getAttribute('data-color'), chatLightBackground());
  }
}
function clearChat() {
  chatRenderQueue = [];
  if (chatRenderFrame !== null) { cancelAnimationFrame(chatRenderFrame); chatRenderFrame = null; }
  if (window.UIImages) UIImages.release(chatMessagesEl());
  chatMessagesEl().innerHTML = ''; ChatWindow.clear();
}
// Chat needs something to belong to: a live stream with a chat room, or a past
// video, which replays the chat from its stream. Say why when it cannot.
function chatCanTurnOn() {
  if (state.vod) return true;
  if (!state.current) { toast('Chat needs a stream or a past video'); return false; }
  if (!currentRoomId()) { toast('Chat is unavailable for this channel'); return false; }
  return true;
}
function toggleChat() {
  applyStreamerChatPreferences();
  if (chatEl().classList.contains('on')) settings.chat = false;
  else {
    if (!chatCanTurnOn()) return;
    settings.chat = true;
  }
  saveSettings();
  syncChat();
  if (state.sidebarOpen) resetIdle();
}
// Bots and !commands are noise on a TV; optionally filter them out.
var CHAT_BOTS = { botrix: 1, nightbot: 1, streamelements: 1, streamlabs: 1, fossabot: 1,
                  wizebot: 1, moobot: 1, kickbot: 1, ohbot: 1 };
function isBotMessage(d) {
  var name = (d.sender && d.sender.username || '').toLowerCase();
  if (CHAT_BOTS[name]) return true;
  return String(d.content || '').replace(/^\s+/, '').charAt(0) === '!';   // chat command
}
function currentRoomId() {
  var c = state.current && state.channels[state.current];
  return (c && c.chatroomId) ? c.chatroomId : null;
}
// What a live channel's socket is for: chat, or (raid follow) the channel's own events.
function chatSocketUse() { return !!(settings.chat || settings.raidFollow); }
// Bring chat into line with the current setting and channel.
function syncChat() {
  applyStreamerChatPreferences();
  // A past video has no socket: its chat is replayed from Kick's history (chat-replay.js).
  if (state.vod) {
    if (chat.want) closeChatSocket();
    syncChatReplay();
    return;
  }
  var room = state.current ? currentRoomId() : null;
  if (!room || !chatSocketUse()) { disconnectChat(); return; }
  if (chat.room === room && (chat.connecting || (chat.ws && chat.ws.readyState <= 1))) {
    // The socket is already up: only what rides on it may have changed.
    syncChatSubscriptions();
    if (settings.chat) openChatView(room); else closeChatView();
    return;
  }
  connectChat(room);
}
function connectChat(room) {
  disconnectChat();
  chat.want = true; chat.room = room; chat.retry = 0;
  chat.viewing = !!settings.chat;
  if (chat.viewing) {
    clearChat(); showChatOverlay(); useSevenTv();
    ChatWindow.status('connecting', 'Connecting...');
  }
  openChatSocket(room);
}
// Chat switched on while the socket was already open for raid follow.
function openChatView(room) {
  showChatOverlay();
  if (chat.viewing) return;
  chat.viewing = true;
  clearChat(); useSevenTv();
  ChatWindow.status(chat.ready ? 'connected' : 'connecting', chat.ready ? 'Live' : 'Connecting...');
  if (chat.ready) loadChatRoomState(room);
}
// Chat switched off while raid follow still needs the socket.
function closeChatView() {
  if (!chat.viewing) return;
  chat.viewing = false;
  clearChatDelay(); resetChatRoomState(); forgetChatSeen();
  hideChatOverlay(); clearChat();
}
// The Pusher channels this socket should be listening to right now. Kick spreads
// one chat room over three of them; the fourth is the channel itself.
function chatChannelsWanted() {
  var list = [], c = state.current && state.channels[state.current];
  if (settings.chat && chat.room) list.push('chatrooms.' + chat.room + '.v2', 'chatrooms.' + chat.room, 'chatroom_' + chat.room);
  if (settings.raidFollow && c && c.channelId) list.push('channel.' + c.channelId);
  return list;
}
function syncChatSubscriptions() {
  var ws = chat.ws;
  if (!ws || !chat.ready) return;
  var want = chatChannelsWanted(), i, name;
  function send(event, channel) {
    try { ws.send(JSON.stringify({ event: event, data: { channel: channel } })); } catch (e) {}
  }
  for (i = 0; i < want.length; i++) {
    if (!chat.subs[want[i]]) { chat.subs[want[i]] = true; send('pusher:subscribe', want[i]); }
  }
  for (name in chat.subs) {
    if (want.indexOf(name) === -1) { delete chat.subs[name]; send('pusher:unsubscribe', name); }
  }
}
// A socket can die without ever closing (router restart, WAN failover): nothing
// arrives and onclose never fires. So we watch for silence ourselves. After the
// server's activity_timeout with no traffic we ping; no answer within 30s means
// the link is dead and we reconnect.
function stopChatHeartbeat() {
  clearTimeout(chat.activityTimer); chat.activityTimer = null;
  clearTimeout(chat.pongTimer); chat.pongTimer = null;
}
function armChatHeartbeat(ws, room) {
  stopChatHeartbeat();
  chat.activityTimer = setTimeout(function () {
    chat.activityTimer = null;
    if (chat.ws !== ws) return;
    try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch (e) {}
    chat.pongTimer = setTimeout(function () {
      chat.pongTimer = null;
      if (chat.ws !== ws) return;
      ws.onclose = null;                       // a dead socket may take minutes to report closing
      try { ws.close(); } catch (e) {}
      chatSocketClosed(ws, room);
    }, 30000);
  }, chat.activityMs);
}
function chatSocketClosed(ws, room) {
  if (chat.ws !== ws) return;
  chat.ws = null; chat.ready = false; chat.subs = {};
  stopChatHeartbeat();
  scheduleChatRetry(room);
}
function scheduleChatRetry(room) {
  if (!(chat.want && chatSocketUse() && currentRoomId() === room)) return;
  if (chat.viewing) ChatWindow.status('reconnecting', 'Reconnecting...');
  chat.retry++;
  var delay = Math.min(15000, 1500 * chat.retry);
  clearTimeout(chat.retryTimer);
  chat.retryTimer = setTimeout(function () {
    chat.retryTimer = null;
    if (chat.want && chatSocketUse() && currentRoomId() === room) openChatSocket(room);
  }, delay);
}
function openChatSocket(room) {
  var channel = state.current && state.channels[state.current];
  var attempt = ++chat.connectAttempt;
  chat.connecting = true;
  var cancel = serviceChatConnection(channel && channel.channelId, function (err, response) {
    if (attempt !== chat.connectAttempt || !chat.want || !chatSocketUse() || chat.room !== room || currentRoomId() !== room) return;
    chat.connecting = false; chat.cancelConnect = null;
    var data = response && response.data, url = null;
    if (!err && data && data.mode === 'websocket' && Array.isArray(data.connections)) {
      for (var i = 0; i < data.connections.length; i++) {
        var connection = data.connections[i], credentials = connection && connection.credentials;
        if (connection && connection.provider === 'pusher' && credentials &&
            typeof credentials.app_key === 'string' && /^[a-zA-Z0-9_-]+$/.test(credentials.app_key) &&
            typeof credentials.cluster === 'string' && /^[a-z0-9-]+$/.test(credentials.cluster)) {
          url = 'wss://ws-' + credentials.cluster + '.pusher.com/app/' + credentials.app_key +
            '?protocol=7&client=js&version=8.4.0&flash=false';
          break;
        }
      }
    }
    if (!url) { scheduleChatRetry(room); return; }
    createChatSocket(room, url);
  });
  // A missing bridge can fail synchronously, before the cancel handle returns.
  if (chat.connecting && attempt === chat.connectAttempt) chat.cancelConnect = cancel;
}
function createChatSocket(room, url) {
  var ws;
  try { ws = new WebSocket(url); }
  catch (e) {
    if (chat.viewing) ChatWindow.status('unavailable', 'Chat connection unavailable');
    scheduleChatRetry(room); return;
  }
  chat.ws = ws; chat.ready = false; chat.subs = {};
  armChatHeartbeat(ws, room);
  ws.onmessage = function (ev) {
    if (chat.ws !== ws || !chat.want || chat.room !== room) return;
    armChatHeartbeat(ws, room);                 // any traffic proves the link is alive
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.event === 'pusher:ping') { try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch (e) {} return; }
    if (m.event === 'pusher:pong') return;
    if (m.event === 'pusher:connection_established') {
      chat.retry = 0;               // connected for real: future drops start from a short delay again
      var info = null; try { info = JSON.parse(m.data); } catch (e) {}
      var secs = info && +info.activity_timeout;
      if (secs > 0) { chat.activityMs = Math.min(300, Math.max(30, secs)) * 1000; armChatHeartbeat(ws, room); }
      chat.ready = true; chat.subs = {};
      syncChatSubscriptions();
      if (chat.viewing) loadChatRoomState(room);   // recent messages, the pin, a running poll
      return;
    }
    if (m.event === 'pusher_internal:subscription_succeeded') {
      if (chat.viewing) ChatWindow.status('connected', 'Live');
      return;
    }
    if (typeof m.event !== 'string' || m.event.indexOf('pusher') === 0) return;
    // Something for a channel we have since left (chat switched off) can still be
    // in flight; it is no longer wanted.
    if (!chat.subs[m.channel]) return;
    // Kick frames an event's payload as a JSON string inside the JSON envelope.
    var d; try { d = JSON.parse(m.data); } catch (e) { return; }
    if (d && typeof d === 'object') handleChatEvent(m.event.replace(/^App\\Events\\/, ''), d);
  };
  ws.onclose = function () { chatSocketClosed(ws, room); };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}
// Everything chat: the live socket and a past video's replay.
function disconnectChat() {
  stopChatReplay();
  closeChatSocket();
}
function closeChatSocket() {
  chat.want = false; chat.room = null;
  chat.viewing = false; chat.ready = false; chat.subs = {};
  chat.connectAttempt++; chat.connecting = false;
  if (chat.cancelConnect) { chat.cancelConnect(); chat.cancelConnect = null; }
  clearChatDelay(); resetChatRoomState(); forgetChatSeen();
  if (chat.retryTimer) { clearTimeout(chat.retryTimer); chat.retryTimer = null; }
  stopChatHeartbeat();
  if (chat.ws) { try { chat.ws.onclose = null; chat.ws.close(); } catch (e) {} chat.ws = null; }
  hideChatOverlay(); clearChat();
}
// Kick puts emotes inline as [emote:12345:Name]. Render the real emote image so
// chat looks like Kick, not "KEKW" text. Built node by node (never innerHTML) so
// message text can never inject markup. If an image fails, fall back to its name.
function chatEmoteImage(url, name) {
  var img = document.createElement('img');
  img.className = 'cemote';
  img.decoding = 'async';   // keep an unseen emote's decode off the paint that shows the message
  img.setAttribute('data-ui-src', url);
  img.setAttribute('data-ui-emote', '1');
  img.alt = name;
  img.onerror = function () {
    if (this.parentNode) this.parentNode.replaceChild(document.createTextNode(name), this);
  };
  return img;
}
// The text between Kick's own emotes, where 7TV emotes hide as plain words.
function appendChatText(row, text) {
  if (settings.chatEmotes === 'text') { row.appendChild(document.createTextNode(text)); return; }
  var parts = chatTextParts(text);
  for (var i = 0; i < parts.length; i++) {
    row.appendChild(parts[i].emote
      ? chatEmoteImage(SEVENTV_CDN + parts[i].emote + '/2x.webp', parts[i].name)
      : document.createTextNode(parts[i].text));
  }
}
function appendChatContent(row, content) {
  content = String(content || '');
  var re = /\[emote:(\d+):([^\]]+)\]/g, last = 0, m;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) appendChatText(row, content.slice(last, m.index));
    if (settings.chatEmotes === 'text') row.appendChild(document.createTextNode(m[2]));   // just the emote name
    else row.appendChild(chatEmoteImage('https://files.kick.com/emotes/' + m[1] + '/fullsize', m[2]));
    last = re.lastIndex;
  }
  if (last < content.length) appendChatText(row, content.slice(last));
}
// Kick tags chatters with badges (broadcaster, mod, sub, VIP, OG...). We show the
// top one or two as small coloured tags before the name, drawn as plain text so
// they render on the TV font (icon glyphs come out as tofu boxes here).
var BADGE_MAP = {
  broadcaster: { label: 'HOST', cls: 'host' },
  moderator:   { label: 'MOD',  cls: 'mod' },
  vip:         { label: 'VIP',  cls: 'vip' },
  og:          { label: 'OG',   cls: 'og' },
  founder:     { label: 'FDR',  cls: 'sub' },
  subscriber:  { label: 'SUB',  cls: 'sub' },
  sub_gifter:  { label: 'GIFT', cls: 'sub' }
};
var BADGE_ORDER = ['broadcaster', 'moderator', 'vip', 'og', 'founder', 'subscriber', 'sub_gifter'];
function badgeChipsFor(sender) {
  var badges = sender && sender.identity && sender.identity.badges;
  if (!badges || !badges.length) return [];
  var have = {};
  badges.forEach(function (b) { if (b && b.type) have[b.type] = true; });
  var out = [];
  for (var i = 0; i < BADGE_ORDER.length && out.length < 2; i++) {
    if (have[BADGE_ORDER[i]]) out.push(BADGE_MAP[BADGE_ORDER[i]]);
  }
  return out;
}
// Kick hands out some very dark identity colours — deep blue, maroon — and chat sits
// over the black player plane, where those names are unreadable from a sofa. Lift
// anything below a usable luminance, keeping which colour it is.
var CHAT_NAME_MIN_LUM = 0.4;
function chatNameColor(hex, lightBackground) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return lightBackground ? '#247500' : '#53fc18';
  var n = parseInt(m[1], 16);
  var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lightBackground) {
    var scale = lum > 0.42 ? 0.42 / lum : 1;
    return 'rgb(' + Math.round(r * scale) + ',' + Math.round(g * scale) + ',' + Math.round(b * scale) + ')';
  }
  if (lum >= CHAT_NAME_MIN_LUM) return '#' + m[1];
  // Blend towards white by exactly the amount that reaches the floor: blending adds
  // (1 - lum) * t of luminance, so t falls straight out. Multiplying the channels
  // instead cannot get a saturated blue there — blue carries 7% of luminance, so it
  // clamps at 255 and stays dark.
  var t = (CHAT_NAME_MIN_LUM - lum) / (1 - lum);
  r = Math.round(r + (255 - r) * t);
  g = Math.round(g + (255 - g) * t);
  b = Math.round(b + (255 - b) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
var chatRenderQueue = [], chatRenderFrame = null;
function chatCovered() { return document.hidden || browse.open || cats.open || vods.open; }
function addChatMessage(d, receivedAt) {
  if (!d || !(d.sender || d.notice)) return;
  if (settings.chatBots === 'hide' && isBotMessage(d)) return;
  chatRenderQueue.push({ data: d, at: receivedAt });
  while (chatRenderQueue.length > CHAT_MAX) chatRenderQueue.shift();
  flushChatRender();
}
function flushChatRender() {
  if (chatCovered() || chatRenderFrame !== null || !chatRenderQueue.length) return;
  chatRenderFrame = requestAnimationFrame(function () {
    chatRenderFrame = null;
    if (chatCovered()) return;
    var box = chatMessagesEl(), fragment = document.createDocumentFragment();
    var batch = chatRenderQueue.splice(0, 40);
    batch.forEach(function (entry) { fragment.appendChild(buildChatMessage(entry.data, entry.at)); });
    var emotes = fragment.querySelectorAll('img[data-ui-src]');   // only the new rows need watching
    box.appendChild(fragment);
    while (box.children.length > CHAT_MAX) {
      if (window.UIImages) UIImages.release(box.firstChild);
      box.removeChild(box.firstChild);
    }
    ChatWindow.messageAdded(batch.length);
    if (window.UIImages && emotes.length) UIImages.watchNodes(emotes);
    if (chatRenderQueue.length) flushChatRender();
  });
}
function buildChatMessage(d, receivedAt) {
  var row = document.createElement('div');
  row.className = d.notice ? 'cmsg cnotice' : 'cmsg';
  // Moderation finds rows by these (dropChatRows).
  if (d.id) row.setAttribute('data-id', String(d.id));
  if (d.sender && d.sender.id) row.setAttribute('data-uid', String(d.sender.id));
  if (settings.chatTimestamps) {
    var ts = document.createElement('span'); ts.className = 'ctime';
    var dt = new Date(receivedAt || Date.now());
    ts.textContent = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2) + ' ';
    row.appendChild(ts);
  }
  if (d.notice) { row.appendChild(document.createTextNode(d.notice)); return row; }
  badgeChipsFor(d.sender).forEach(function (c) {
    var b = document.createElement('span');
    b.className = 'cbadge ' + c.cls;
    b.textContent = c.label;
    row.appendChild(b);
  });
  var u = document.createElement('span');
  u.className = 'cuser';
  var color = d.sender.identity && d.sender.identity.color;
  u.setAttribute('data-color', color || '');
  u.style.color = chatNameColor(color, chatLightBackground());
  u.textContent = d.sender.username || '';
  row.appendChild(u);
  // ': ' rather than a bare space — without it the coloured name and the white message
  // run together into one blob at sofa distance. Kick's own chat does the same.
  row.appendChild(document.createTextNode(': '));
  appendChatContent(row, d.content);
  return row;
}
