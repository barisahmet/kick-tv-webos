// Shared harness for the chat scripts. They run in a bare VM context with a fake
// clock, fake timers, a fake socket and a recording service, so each test drives
// time and the network by hand. Synthetic channels only: alpha and beta.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const FILES = ['chat-overlay.js', 'chat-emotes.js', 'chat-events.js', 'chat-replay.js', 'raid.js', 'sleep.js'];
const source = FILES.map(f => fs.readFileSync(path.join(__dirname, '../app/js', f), 'utf8')).join('\n');

function harness(options = {}) {
  let now = 1800000000000, nextTimer = 1;
  const requests = [], gets = [], calls = [], sockets = [], timers = [];
  const shown = [], dropped = [], toasts = [], played = [], heads = [], idled = [], dimmed = [], warnings = [], saves = [];
  const video = { currentTime: 0, paused: false, playbackRate: 1, readyState: 4, seeking: false };
  function addTimer(fn, ms, repeat) {
    const t = { id: nextTimer++, fn, ms: ms || 0, at: now + (ms || 0), repeat: !!repeat, cancelled: false };
    timers.push(t); return t;
  }
  // Advance the clock, firing whatever falls due in order (each timer at its own time).
  function tick(ms = 0) {
    const end = now + ms;
    for (let turns = 0; ; turns++) {
      assert.ok(turns < 20000, 'timer loop stays bounded');
      const due = timers.filter(t => !t.cancelled && !t.fired && t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      if (due.repeat) due.at += Math.max(1, due.ms); else due.fired = true;
      due.fn();
    }
    now = end;
  }
  const h = {
    settings: Object.assign({ chat: true, chatDelay: 0, chatEvents: true, chatPinned: true, chatBots: 'show',
      chatEmotes: 'images', raidFollow: false, autoadvance: false }, options.settings),
    state: Object.assign({ current: 'alpha', vod: null, ready: true, mode: 'player', sidebarOpen: false, hls: null, channels: {
      alpha: { slug: 'alpha', name: 'Alpha', live: true, channelId: 42, chatroomId: 1, userId: 7 },
      beta: { slug: 'beta', name: 'Beta', live: true, channelId: 43, chatroomId: 2, userId: 8 } } }, options.state),
    window: {}, console,
    KEY: { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, STOP: 413 },
    ChatWindow: { status() {}, messageAdded() {}, show() {}, hide() {}, clear() {} },
    document: { hidden: false, getElementById: id => (id === 'video' ? video : null) },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => addTimer(fn, ms, false),
    clearTimeout(t) { if (t) t.cancelled = true; },
    setInterval: (fn, ms) => addTimer(fn, ms, true),
    clearInterval(t) { if (t) t.cancelled = true; },
    serviceChatConnection(id, cb) {
      const request = { id, cb, cancelled: false }; requests.push(request);
      return () => { request.cancelled = true; };
    },
    // Kick lookups the chat scripts make: recorded, answered by the test.
    serviceGet(p, cb, opts) {
      const get = { path: p, cb, opts, cancelled: false }; gets.push(get);
      return { cancel() { get.cancelled = true; } };
    },
    serviceRequest(method, payload, cb) {
      const call = { method, payload, cb, cancelled: false }; calls.push(call);
      return () => { call.cancelled = true; };
    },
    apiGet(slug, cb) { gets.push({ path: 'channel:' + slug, cb }); },
    normalize: (slug, raw) => ({ slug, channelId: raw.id || null, userId: (raw.user && raw.user.id) || null,
      chatroomId: (raw.chatroom && raw.chatroom.id) || null }),
    toast: msg => toasts.push(msg),
    saveSettings() { saves.push(now); },
    play: slug => played.push(slug),
    returnToIdle: () => idled.push(now),
    showSaver: () => dimmed.push(now),
    renderSettings() {},
    anyPanelOpen: () => false,
    liveLatencySec: () => 0,
    isFavorite: () => true,
    WebSocket: function (url) {
      this.url = url; this.readyState = 0; this.sent = [];
      this.send = msg => this.sent.push(JSON.parse(msg));
      this.close = () => { this.readyState = 3; if (this.onclose) this.onclose(); };
      sockets.push(this);
    }
  };
  vm.createContext(h); vm.runInContext(source, h);
  // The scripts' few DOM-facing functions, replaced by recorders.
  h.clearChat = () => { shown.length = 0; };
  h.showChatOverlay = h.hideChatOverlay = h.applyStreamerChatPreferences = h.applyChatStyle = () => {};
  h.addChatMessage = (d, at) => shown.push(Object.assign({ shownAt: at }, d));
  h.dropChatRows = (attr, value) => dropped.push([attr, value]);
  h.renderChatHead = () => heads.push({ pin: h.chatPin && h.chatPin.id, poll: h.chatPoll && h.chatPoll.title });
  h.renderChatPoll = h.renderRaid = () => {};
  h.renderSleepWarning = seconds => warnings.push(seconds);

  const descriptor = (key = 'key', cluster = 'us2') =>
    ({ data: { mode: 'websocket', connections: [{ provider: 'pusher', credentials: { app_key: key, cluster } }] } });
  // Answer every room lookup still waiting (recent messages, poll) with "nothing there".
  function settle() {
    for (const get of gets) {
      if (get.answered || get.cancelled) continue;
      if (/\/messages$/.test(get.path)) { get.answered = true; get.cb(null, { data: { messages: [], pinned_message: null } }); }
      else if (/\/polls$/.test(get.path)) { get.answered = true; get.cb(null, { data: null }); }
    }
  }
  // Connect the current channel all the way: descriptor answered, socket established.
  // The room's own lookups are answered empty unless the test wants to answer them.
  function connect(opts = {}) {
    h.syncChat();
    requests[requests.length - 1].cb(null, descriptor());
    const socket = sockets[sockets.length - 1];
    socket.readyState = 1;
    socket.onmessage({ data: JSON.stringify({ event: 'pusher:connection_established', data: '{"activity_timeout":120}' }) });
    if (!opts.pending) settle();
    return socket;
  }
  // Deliver one Pusher event the way the server frames it (data is a JSON string).
  function event(socket, channel, name, data) {
    socket.onmessage({ data: JSON.stringify({ event: name, channel, data: JSON.stringify(data) }) });
  }
  const subscribed = socket => socket.sent.filter(m => m.event === 'pusher:subscribe').map(m => m.data.channel);
  const unsubscribed = socket => socket.sent.filter(m => m.event === 'pusher:unsubscribe').map(m => m.data.channel);
  const message = (id, user, content, extra = {}) => Object.assign({ id, chatroom_id: 1, content, type: 'message',
    created_at: new Date(now).toISOString(), sender: { id: user, username: 'user' + user, slug: 'user' + user,
      identity: { color: '#75FD46', badges: [] } } }, extra);
  return { h, requests, gets, calls, sockets, timers, shown, dropped, toasts, played, heads, idled, dimmed, warnings, saves, video,
    descriptor, connect, settle, event, subscribed, unsubscribed, message, tick, now: () => now };
}
module.exports = { harness };
