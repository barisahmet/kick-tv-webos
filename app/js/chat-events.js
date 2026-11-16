'use strict';
/* What the chat socket's events mean (chat-overlay.js owns the socket itself).

   Kick spreads one room over several Pusher channels:
     chatrooms.<room>.v2   messages, deletions, bans, pins, polls, subscriptions
     chatrooms.<room>      an incoming raid (Kick calls it a host)
     chatroom_<room>       gifted subscriptions
     channel.<channel>     the streamer sending the audience elsewhere (raid.js)
   Event names arrive as "App\Events\Name"; the prefix is already stripped here.

   Everything below is read-only, the same as the messages. */

/* Subscriptions, gifts and raids become one plain line each, queued like a message
   so they keep their place in the conversation and wait for the video with it. */
function chatName(value) {
  return typeof value === 'string' && value ? value.slice(0, 60) : '';
}
function fmtCount(n) {
  return String(Math.max(0, Math.round(+n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function chatNoticeFor(name, d) {
  var who;
  if (name === 'SubscriptionEvent') {
    who = chatName(d.username);
    if (!who) return '';
    return who + ' subscribed' + (d.months > 1 ? ' for ' + fmtCount(d.months) + ' months' : '');
  }
  if (name === 'GiftedSubscriptionsEvent') {
    // A large gift arrives in pieces that share one correlation id; the first speaks for all.
    if (d.chunk_details && d.chunk_details.chunk_index > 0) return '';
    var names = Array.isArray(d.gifted_usernames) ? d.gifted_usernames : [];
    var total = Math.max(+d.gifted_total || 0, names.length);
    if (!total) return '';
    who = chatName(d.gifter_username) || 'Someone';
    if (total === 1 && chatName(names[0])) return who + ' gifted a sub to ' + chatName(names[0]);
    return who + ' gifted ' + fmtCount(total) + (total === 1 ? ' sub' : ' subs');
  }
  if (name === 'StreamHostedEvent') {
    who = chatName(d.user && d.user.username);
    var viewers = d.message && +d.message.numberOfViewers;
    if (!who || !(viewers >= 0)) return '';
    return who + ' raided with ' + fmtCount(viewers) + (Math.round(viewers) === 1 ? ' viewer' : ' viewers');
  }
  return '';
}
function queueChatNotice(text, id) {
  if (!text || settings.chatEvents === false) return;
  queueChatMessage(id ? { id: id, notice: text } : { notice: text });
}
// A renewal comes as a chat message of type "celebration", usually just the party
// emoji Kick fills in. The line says what happened; the text is kept only when the
// chatter actually wrote something.
function celebrationNotice(d) {
  var c = d.metadata && d.metadata.celebration, who = chatName(d.sender && d.sender.username);
  if (!c || c.type !== 'subscription_renewed' || !who) return '';
  return who + ' resubscribed' + (c.total_months > 1 ? ' for ' + fmtCount(c.total_months) + ' months' : '');
}
function chatSaysSomething(content) {
  return String(content || '').replace(/\[emote:\d+:[^\]]+\]/g, 'x')
    .replace(/[\uD800-\uDFFF☀-➿️‍\s]/g, '').length > 0;
}
// What one chat message puts in the window: itself, and for a renewal its line.
function chatLinesFor(d) {
  if (!d || !d.sender) return [];
  if (d.type === 'celebration') {
    var line = celebrationNotice(d);
    if (line) {
      var out = settings.chatEvents === false ? [] : [{ id: d.id ? 'celebration:' + d.id : '', notice: line }];
      if (chatSaysSomething(d.content)) out.push(d);
      return out;
    }
  }
  return [d];
}
// One live chat message, or one from the room's history (`at`: when it was sent).
function receiveChatMessage(d, at) {
  var lines = chatLinesFor(d);
  for (var i = 0; i < lines.length; i++) queueChatMessage(lines[i], at);
}

function handleChatEvent(name, d) {
  // The channel's own event, wanted whether or not the chat window is open.
  if (name === 'ChatMoveToSupportedChannelEvent') { onRaidOut(d); return; }
  if (!chat.viewing) return;
  if (name === 'ChatMessageEvent') {
    ChatWindow.status('connected', 'Live');
    receiveChatMessage(d);
  } else if (name === 'MessageDeletedEvent') {
    var id = d.message && d.message.id;
    if (typeof id === 'string' && id) {
      dropChatMessages('id', id);
      if (chatPin && chatPin.id === id) setChatPin(null);
    }
  } else if (name === 'UserBannedEvent') {
    var uid = d.user && d.user.id;
    if (typeof uid === 'number' && uid > 0) dropChatMessages('uid', uid);
  } else if (name === 'ChatroomClearEvent') {
    clearChatDelay(); clearChat();
  } else if (name === 'PinnedMessageCreatedEvent') {
    var minutes = +d.duration;                       // Kick gives a pin's length in minutes
    setChatPin(d.message, minutes > 0 ? Date.now() + minutes * 60000 : 0);
  } else if (name === 'PinnedMessageDeletedEvent') {
    setChatPin(null);
  } else if (name === 'PollUpdateEvent') {
    setChatPoll(d.poll);
  } else if (name === 'PollDeleteEvent') {
    setChatPoll(null);
  } else {
    queueChatNotice(chatNoticeFor(name, d));
  }
}

/* The room's state when chat opens: its last messages, the pinned message and a
   running poll. Asked again after a reconnect, which also fills the gap. */
var CHAT_HISTORY_WAIT_MS = 2500;
var chatRoomLoads = [];
function cancelChatLoad(handle) {
  try {
    if (typeof handle === 'function') handle();
    else if (handle && handle.cancel) handle.cancel();
  } catch (e) {}
}
function cancelChatRoomLoads() {
  for (var i = 0; i < chatRoomLoads.length; i++) cancelChatLoad(chatRoomLoads[i]);
  chatRoomLoads = [];
  releaseChatHold(true);
}
function resetChatRoomState() {
  cancelChatRoomLoads();
  setChatPin(null);
  setChatPoll(null);
}
function loadChatRoomState(room) {
  cancelChatRoomLoads();
  var slug = state.current, c = slug && state.channels[slug];
  if (!c || !c.channelId) return;
  function wanted() { return chat.want && chat.viewing && chat.room === room && currentRoomId() === room; }
  holdChat(CHAT_HISTORY_WAIT_MS);
  chatRoomLoads.push(serviceGet('/api/v2/channels/' + c.channelId + '/messages', function (err, body) {
    if (!wanted()) return;
    var data = !err && body && body.data;
    if (data) {
      applyChatHistory(data.messages);
      var pin = data.pinned_message;
      setChatPin(pin && pin.message, pin && Date.parse(pin.finish_at));
    }
    releaseChatHold();
  }, { priority: 2 }));
  chatRoomLoads.push(serviceGet('/api/v2/channels/' + encodeURIComponent(slug) + '/polls', function (err, body) {
    if (!wanted()) return;
    var poll = !err && body && body.data && body.data.poll;
    if (poll) setChatPoll(poll);
  }, { priority: 2 }));
}
// History carries metadata as a JSON string where the live event has an object.
function chatMessageFromHistory(m) {
  if (!m || !m.sender) return null;
  if (typeof m.metadata === 'string') {
    try { m.metadata = JSON.parse(m.metadata); } catch (e) { m.metadata = null; }
  }
  return m;
}
function applyChatHistory(list) {
  if (!Array.isArray(list)) return;
  var items = [];
  for (var i = 0; i < list.length; i++) {
    var m = chatMessageFromHistory(list[i]);
    if (!m) continue;
    var at = Date.parse(m.created_at);
    items.push({ m: m, at: isFinite(at) ? at : 0 });
  }
  items.sort(function (a, b) { return a.at - b.at; });
  for (var j = 0; j < items.length; j++) receiveChatMessage(items[j].m, items[j].at);
}

/* The pinned message and a running poll sit above the messages. */
var chatPin = null, chatPinTimer = null;   // the pinned message, as Kick sent it
// finishAt: when the pin runs out (ms), or nothing when that is not known.
function setChatPin(message, finishAt) {
  if (chatPinTimer !== null) { clearTimeout(chatPinTimer); chatPinTimer = null; }
  var now = Date.now();
  var usable = message && message.sender && typeof message.id === 'string' && message.id;
  chatPin = usable && !(finishAt > 0 && finishAt <= now) ? message : null;
  // Take it down when its time is up, in case nothing announces that.
  if (chatPin && finishAt > now) {
    chatPinTimer = setTimeout(function () { chatPinTimer = null; setChatPin(null); }, Math.min(finishAt - now, 2147483647));
  }
  renderChatHead();
}
// A 7TV set arrived after the pin was drawn: draw it again so its emotes show.
function redrawChatPin() {
  if (!chatPin) return;
  chatPinShown = '';
  renderChatPin();
}
var CHAT_POLL_OPTIONS_MAX = 6;
var chatPoll = null, chatPollTimer = null;   // { title, options: [{ label, votes }], endsAt, clearAt }
function setChatPoll(poll) {
  if (chatPollTimer !== null) { clearInterval(chatPollTimer); chatPollTimer = null; }
  var options = [];
  if (poll && typeof poll.title === 'string' && Array.isArray(poll.options)) {
    for (var i = 0; i < poll.options.length && options.length < CHAT_POLL_OPTIONS_MAX; i++) {
      var o = poll.options[i];
      if (o && typeof o.label === 'string') options.push({ label: o.label.slice(0, 80), votes: Math.max(0, +o.votes || 0) });
    }
  }
  if (!options.length) { chatPoll = null; renderChatHead(); return; }
  var now = Date.now(), left = Math.max(0, +poll.remaining || 0), results = Math.max(0, +poll.result_display_duration || 0);
  chatPoll = { title: poll.title.slice(0, 120), options: options,
    endsAt: now + left * 1000, clearAt: now + (left + results) * 1000 };
  chatPollTimer = setInterval(tickChatPoll, 1000);
  renderChatHead();
}
function chatPollLeftSec() {
  return chatPoll ? Math.max(0, Math.ceil((chatPoll.endsAt - Date.now()) / 1000)) : 0;
}
// Once a second: count down, then take the poll away after its results had their time.
// Only the countdown is touched; the rows are redrawn when the votes change.
function tickChatPoll() {
  if (!chatPoll) return;
  if (Date.now() >= chatPoll.clearAt) { setChatPoll(null); return; }
  paintChatPollLeft();
}
function paintChatPollLeft() {
  var el = document.getElementById('chat-poll-left');
  if (!el || !chatPoll) return;
  var left = chatPollLeftSec(), text = left ? left + 's' : 'ended';
  if (el.textContent !== text) el.textContent = text;
}

function chatHeadShown() { return settings.chatPinned !== false && !!(chatPin || chatPoll); }
function renderChatHead() {
  var head = document.getElementById('chat-head');
  if (!head) return;
  var cls = chatHeadShown() ? '' : 'hidden', changed = head.className !== cls;
  // Shown before it is filled: the image loader only takes emotes that are on screen.
  if (changed) head.className = cls;
  renderChatPin();
  renderChatPoll();
  if (changed) ChatWindow.tail();   // the messages below just gained or lost room
}
// Rebuilt only when the pin changes: it can hold emote images, which should not reload.
var chatPinShown = '';
function renderChatPin() {
  var box = document.getElementById('chat-pin');
  if (!box) return;
  var key = chatPin && settings.chatPinned !== false ? chatPin.id + '|' + settings.chatEmotes : '';
  if (key === chatPinShown) return;
  chatPinShown = key;
  if (window.UIImages) UIImages.release(box);
  box.textContent = '';
  box.className = key ? '' : 'hidden';
  if (!key) return;
  var label = document.createElement('span');
  label.className = 'chead-label'; label.textContent = 'Pinned';
  box.appendChild(label);
  var name = document.createElement('span');
  name.className = 'cuser'; name.textContent = chatPin.sender.username || '';
  box.appendChild(name);
  box.appendChild(document.createTextNode(': '));
  appendChatContent(box, chatPin.content);
  var emotes = box.querySelectorAll('img[data-ui-src]');
  if (window.UIImages && emotes.length) UIImages.watchNodes(emotes);
}
function renderChatPoll() {
  var box = document.getElementById('chat-poll');
  if (!box) return;
  var show = chatPoll && settings.chatPinned !== false;
  box.className = show ? '' : 'hidden';
  if (!show) { if (box.firstChild) box.textContent = ''; return; }
  var total = 0, i;
  for (i = 0; i < chatPoll.options.length; i++) total += chatPoll.options[i].votes;
  box.textContent = '';
  var title = document.createElement('div');
  title.className = 'cpoll-title';
  var label = document.createElement('span');
  label.className = 'chead-label'; label.textContent = 'Poll';
  title.appendChild(label);
  title.appendChild(document.createTextNode(chatPoll.title));
  var time = document.createElement('span');
  time.id = 'chat-poll-left'; time.className = 'cpoll-left';
  title.appendChild(time);
  box.appendChild(title);
  for (i = 0; i < chatPoll.options.length; i++) {
    var o = chatPoll.options[i], pct = total ? Math.round(o.votes * 100 / total) : 0;
    var row = document.createElement('div'); row.className = 'cpoll-row';
    var bar = document.createElement('span'); bar.className = 'cpoll-bar'; bar.style.width = pct + '%';
    var text = document.createElement('span'); text.className = 'cpoll-text'; text.textContent = o.label;
    var share = document.createElement('span'); share.className = 'cpoll-pct'; share.textContent = pct + '%';
    row.appendChild(bar); row.appendChild(text); row.appendChild(share);
    box.appendChild(row);
  }
  paintChatPollLeft();
}
