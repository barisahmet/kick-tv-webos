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
   Sending would need an account, which this app deliberately does not do. */
var CHAT_KEY = '32cbd69e4b950bf97679';   // Kick's public Pusher app key (us2)
var CHAT_URL = 'wss://ws-us2.pusher.com/app/' + CHAT_KEY + '?protocol=7&client=js&version=8.4.0&flash=false';
var CHAT_MAX = 160;                       // bounded scrollback, including off-screen messages
var CHAT_DELAY_MAX = 1000;
var chatPending = [], chatDelayTimer = null;
var chat = { ws: null, room: null, want: false, retry: 0, retryTimer: null,
             activityMs: 120000, activityTimer: null, pongTimer: null };
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
  if (chatDelayTimer !== null || !chatPending.length) return;
  var wait = Math.max(0, chatPending[0].at + chatDelayMs() - Date.now());
  if (settings.chatDelay < 0) wait = Math.min(wait, 1000);
  chatDelayTimer = setTimeout(drainChatDelay, wait);
}
function drainChatDelay() {
  if (chatDelayTimer !== null) clearTimeout(chatDelayTimer);
  chatDelayTimer = null;
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
function queueChatMessage(data) {
  if (!data || !data.sender || !chat.want || !settings.chat) return;
  chatPending.push({ data: data, at: Date.now(), room: chat.room });
  if (chatPending.length > CHAT_DELAY_MAX) chatPending.shift();
  if (settings.chatDelay === 0 && chatPending.length === 1 && chatDelayTimer === null) drainChatDelay();
  else scheduleChatDelay();
}
function clearChatDelay() {
  if (chatDelayTimer !== null) clearTimeout(chatDelayTimer);
  chatDelayTimer = null; chatPending = [];
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
// Chat only exists on a live stream with a chat room; say why when it cannot.
function chatCanTurnOn() {
  if (!state.current || state.vod) { toast('Chat is available on live streams'); return false; }
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
// Bring chat into line with the current setting and channel.
function syncChat() {
  applyStreamerChatPreferences();
  if (!settings.chat || !state.current) { disconnectChat(); return; }
  var room = currentRoomId();
  if (!room) { disconnectChat(); return; }
  if (chat.room === room && chat.ws && chat.ws.readyState <= 1) { showChatOverlay(); return; }
  connectChat(room);
}
function connectChat(room) {
  disconnectChat();
  chat.want = true; chat.room = room; chat.retry = 0;
  clearChat(); showChatOverlay();
  ChatWindow.status('connecting', 'Connecting...');
  openChatSocket(room);
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
  chat.ws = null;
  stopChatHeartbeat();
  scheduleChatRetry(room);
}
function scheduleChatRetry(room) {
  if (!(chat.want && settings.chat && currentRoomId() === room)) return;
  ChatWindow.status('reconnecting', 'Reconnecting...');
  chat.retry++;
  var delay = Math.min(15000, 1500 * chat.retry);
  clearTimeout(chat.retryTimer);
  chat.retryTimer = setTimeout(function () {
    chat.retryTimer = null;
    if (chat.want && settings.chat && currentRoomId() === room) openChatSocket(room);
  }, delay);
}
function openChatSocket(room) {
  var ws;
  try { ws = new WebSocket(CHAT_URL); }
  catch (e) { ChatWindow.status('unavailable', 'Chat connection unavailable'); scheduleChatRetry(room); return; }
  chat.ws = ws;
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
      try { ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'chatrooms.' + room + '.v2' } })); } catch (e) {}
      return;
    }
    if (m.event === 'pusher_internal:subscription_succeeded') { ChatWindow.status('connected', 'Live'); return; }
    if (m.event && m.event.indexOf('ChatMessageEvent') !== -1) {
      var d; try { d = JSON.parse(m.data); } catch (e) { return; }
      ChatWindow.status('connected', 'Live');
      queueChatMessage(d);
    }
  };
  ws.onclose = function () { chatSocketClosed(ws, room); };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}
function disconnectChat() {
  chat.want = false; chat.room = null;
  clearChatDelay();
  if (chat.retryTimer) { clearTimeout(chat.retryTimer); chat.retryTimer = null; }
  stopChatHeartbeat();
  if (chat.ws) { try { chat.ws.onclose = null; chat.ws.close(); } catch (e) {} chat.ws = null; }
  hideChatOverlay(); clearChat();
}
// Kick puts emotes inline as [emote:12345:Name]. Render the real emote image so
// chat looks like Kick, not "KEKW" text. Built node by node (never innerHTML) so
// message text can never inject markup. If an image fails, fall back to its name.
function appendChatContent(row, content) {
  content = String(content || '');
  var re = /\[emote:(\d+):([^\]]+)\]/g, last = 0, m;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) row.appendChild(document.createTextNode(content.slice(last, m.index)));
    if (settings.chatEmotes === 'text') {
      row.appendChild(document.createTextNode(m[2]));   // just the emote name, no image
    } else {
      var img = document.createElement('img');
      img.className = 'cemote';
      img.decoding = 'async';   // keep an unseen emote's decode off the paint that shows the message
      img.setAttribute('data-ui-src', 'https://files.kick.com/emotes/' + m[1] + '/fullsize');
      img.setAttribute('data-ui-emote', '1');
      img.alt = m[2];
      (function (name) {
        img.onerror = function () {
          if (this.parentNode) this.parentNode.replaceChild(document.createTextNode(name), this);
        };
      })(m[2]);
      row.appendChild(img);
    }
    last = re.lastIndex;
  }
  if (last < content.length) row.appendChild(document.createTextNode(content.slice(last)));
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
  if (!d || !d.sender) return;
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
  row.className = 'cmsg';
  if (settings.chatTimestamps) {
    var ts = document.createElement('span'); ts.className = 'ctime';
    var dt = new Date(receivedAt || Date.now());
    ts.textContent = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2) + ' ';
    row.appendChild(ts);
  }
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
