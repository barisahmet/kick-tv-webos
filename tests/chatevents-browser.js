/* What chat events look like on screen: moderation, event lines, the pinned
   message, a poll, 7TV emotes, the raid prompt and a past video's replay. */
window.runChateventsTests = async function (assert) {
  var EV = 'App\\Events\\';
  function rows() { return Array.prototype.slice.call(chatMessagesEl().children); }
  function texts() { return rows().map(function (r) { return r.textContent; }); }
  function visible(id) { var el = document.getElementById(id); return !!el && el.className.indexOf('hidden') === -1 && el.offsetHeight > 0; }
  async function drained() {
    await fixtureUntil(function () { return !chatRenderQueue.length && chatRenderFrame === null; });
  }
  function send(channel, name, data) {
    chat.ws.onmessage({ data: JSON.stringify({ event: name, channel: channel, data: JSON.stringify(data) }) });
  }
  function message(id, uid, content, extra) {
    var m = { id: id, chatroom_id: 1, content: content, type: 'message', created_at: new Date().toISOString(),
      sender: { id: uid, username: 'viewer' + uid, slug: 'viewer' + uid, identity: { color: '#75FD46', badges: [] } } };
    for (var k in extra) m[k] = extra[k];
    return m;
  }
  settings.chat = true; settings.chatDelay = 0; settings.raidFollow = true;
  settings.chatEvents = true; settings.chatPinned = true; settings.chatEmotes = 'images';
  syncChat();
  await fixtureUntil(function () { return !!chat.ws; });
  chat.ws.onmessage({ data: JSON.stringify({ event: 'pusher:connection_established', data: '{"activity_timeout":120}' }) });
  await fixtureUntil(function () { return chatHold === null; });   // the fixture's history lookup has failed

  // Moderation
  send('chatrooms.1.v2', EV + 'ChatMessageEvent', message('m1', 5, 'first'));
  send('chatrooms.1.v2', EV + 'ChatMessageEvent', message('m2', 6, 'second'));
  send('chatrooms.1.v2', EV + 'ChatMessageEvent', message('m3', 5, 'third'));
  await drained();
  assert(texts().join('|') === 'viewer5: first|viewer6: second|viewer5: third', 'messages render in order');
  send('chatrooms.1.v2', EV + 'MessageDeletedEvent', { id: 'e1', message: { id: 'm2' } });
  assert(texts().join('|') === 'viewer5: first|viewer5: third', 'a deleted message leaves the window');
  send('chatrooms.1.v2', EV + 'UserBannedEvent', { id: 'e2', user: { id: 5, username: 'viewer5', slug: 'viewer5' }, permanent: true });
  assert(rows().length === 0, 'a banned chatter\'s messages all leave the window');

  // Event lines
  send('chatrooms.1.v2', EV + 'SubscriptionEvent', { chatroom_id: 1, username: 'Mira', months: 4 });
  send('chatrooms.1', EV + 'StreamHostedEvent', { user: { username: 'Nova' }, message: { numberOfViewers: 1500 } });
  await drained();
  assert(texts().join('|') === 'Mira subscribed for 4 months|Nova raided with 1,500 viewers', 'subscriptions and raids are lines in chat');
  assert(rows()[0].className === 'cmsg cnotice', 'event lines are styled apart from messages');

  // 7TV emotes: plain words in the message, pictures on screen
  storeSevenTvSet('global', [['Clap', '62fc0a0c4a75fd54bd3520a9']]);
  sevenTv.current = '77'; storeSevenTvSet('77', [['GAMBA', '01G3WEGZN0000ET2J0MQP5YJ0G']]);
  send('chatrooms.1.v2', EV + 'ChatMessageEvent', message('m4', 7, 'nice GAMBA and [emote:37226:KEKW] Clap <b>x</b>'));
  await drained();
  var emoteRow = rows()[2], imgs = emoteRow.querySelectorAll('img.cemote');
  assert(imgs.length === 3, 'a 7TV word, a Kick emote and a global 7TV word each become an image');
  assert(imgs[0].getAttribute('data-ui-src') === 'https://cdn.7tv.app/emote/01G3WEGZN0000ET2J0MQP5YJ0G/2x.webp' && imgs[0].alt === 'GAMBA', 'the 7TV image comes from its CDN by id');
  assert(imgs[1].getAttribute('data-ui-src') === 'https://files.kick.com/emotes/37226/fullsize', 'Kick emotes are unchanged');
  assert(emoteRow.querySelector('b') === null && emoteRow.textContent.indexOf('<b>x</b>') !== -1, 'message text stays text');
  settings.chatEmotes = 'text';
  send('chatrooms.1.v2', EV + 'ChatMessageEvent', message('m5', 7, 'GAMBA [emote:37226:KEKW]'));
  await drained();
  assert(rows()[3].querySelectorAll('img').length === 0 && rows()[3].textContent === 'viewer7: GAMBA KEKW', 'text mode shows names only');
  settings.chatEmotes = 'images';

  // Pinned message and poll
  assert(!visible('chat-head'), 'the header is hidden when nothing is pinned');
  send('chatrooms.1.v2', EV + 'PinnedMessageCreatedEvent', { message: message('p1', 9, 'Finals start at 9 GAMBA'), duration: '1200' });
  assert(visible('chat-head') && visible('chat-pin'), 'a pinned message appears above the chat');
  assert(document.getElementById('chat-pin').textContent.indexOf('viewer9: Finals start at 9') !== -1, 'with its author and text');
  var pinEmote = document.getElementById('chat-pin').querySelector('img.cemote');
  assert(document.getElementById('chat-pin').querySelectorAll('img.cemote').length === 1, 'and its emotes');
  assert(!!pinEmote._uiImage && pinEmote.getAttribute('data-ui-image-state') !== null, 'which are handed to the image loader, though the header was hidden until now');
  var scroll = document.getElementById('chat-scroll').getBoundingClientRect(), head = document.getElementById('chat-head').getBoundingClientRect();
  assert(head.bottom <= scroll.top + 1, 'the header sits above the messages, not over them');
  send('chatrooms.1.v2', EV + 'PollUpdateEvent', { poll: { title: 'Next game?', remaining: 30, result_display_duration: 15,
    options: [{ id: 0, label: 'Chess', votes: 3 }, { id: 1, label: 'Poker', votes: 1 }] } });
  var pollText = document.getElementById('chat-poll').textContent;
  assert(visible('chat-poll') && pollText.indexOf('Next game?') !== -1 && pollText.indexOf('Chess75%') !== -1 && pollText.indexOf('Poker25%') !== -1, 'a poll shows its options and shares');
  assert(document.querySelector('#chat-poll .cpoll-bar').style.width === '75%', 'with a bar per option');
  // The countdown ticks without rebuilding the poll.
  var firstRow = document.querySelector('#chat-poll .cpoll-row'), before = document.querySelector('#chat-poll .cpoll-left').textContent;
  chatPoll.endsAt -= 5000; tickChatPoll();
  assert(document.querySelector('#chat-poll .cpoll-left').textContent !== before && /^\d+s$/.test(document.querySelector('#chat-poll .cpoll-left').textContent), 'the poll counts down');
  assert(document.querySelector('#chat-poll .cpoll-row') === firstRow, 'without rebuilding its rows every second');
  chatPoll.endsAt = Date.now() - 1000; tickChatPoll();
  assert(document.querySelector('#chat-poll .cpoll-left').textContent === 'ended', 'and says when voting has ended');
  // A 7TV set that arrives after the pin was drawn still reaches it.
  send('chatrooms.1.v2', EV + 'PinnedMessageCreatedEvent', { message: message('p2', 9, 'welcome peepoHey'), duration: '1200' });
  assert(document.getElementById('chat-pin').querySelectorAll('img.cemote').length === 0, 'an emote whose set has not loaded is plain text');
  var late = serviceRequest; serviceRequest = function (method, payload, cb) { cb(null, { emotes: [['peepoHey', '60ae7316f7c927fad14e6ca2']] }); return function () {}; };
  delete sevenTv.sets['77']; sevenTv.order = []; loadSevenTvSet('77', { userId: 77 });
  serviceRequest = late;
  assert(document.getElementById('chat-pin').querySelectorAll('img.cemote').length === 1, 'and becomes an image when the set arrives');
  settings.chatPinned = false; renderChatHead();
  assert(!visible('chat-head'), 'the Pinned message option hides both');
  settings.chatPinned = true; renderChatHead();
  send('chatrooms.1.v2', EV + 'PollDeleteEvent', {});
  send('chatrooms.1.v2', EV + 'PinnedMessageDeletedEvent', {});
  assert(!visible('chat-head') && document.getElementById('chat-pin').textContent === '', 'unpinning and ending the poll clear the header');

  // Raid prompt
  send('channel.41', EV + 'ChatMoveToSupportedChannelEvent', { slug: 'alpha', hosted: { slug: 'beta', username: 'Beta' } });
  assert(visible('raid-next') && raid.open, 'a raid opens the prompt');
  assert(document.getElementById('raid-next-title').textContent === 'Alpha is raiding Beta', 'naming both channels');
  assert(/^Following in \d+ seconds?$/.test(document.getElementById('raid-next-count').textContent), 'with a countdown');
  assert(document.getElementById('raid-next-stay').classList.contains('focused') && anyPanelOpen(), 'Stay is focused and the prompt counts as open UI');
  var raidLayer = document.getElementById('raid-next').getBoundingClientRect(), raidCard = document.getElementById('raid-next-box').getBoundingClientRect();
  assert(raidLayer.width <= raidCard.width + 2 && raidLayer.height <= raidCard.height + 2, 'the prompt is only its card: nothing is laid over the live picture');
  assert(raidCard.right <= 1920 && raidCard.left >= 1100 && raidCard.bottom <= 1000 && raidCard.top >= 700, 'in the bottom right corner');
  var under = document.elementFromPoint(400, 400);
  assert(!document.getElementById('raid-next').contains(under), 'so the rest of the screen still takes the pointer');
  document.getElementById('raid-next-stay').click();
  assert(!visible('raid-next') && !raid.open && state.current === 'alpha', 'Stay keeps the stream');
  send('channel.41', EV + 'ChatMoveToSupportedChannelEvent', { slug: 'alpha', hosted: { slug: 'beta', username: 'Beta' } });
  assert(!visible('raid-next') && !raid.open, 'the same announcement again does not bring the prompt back');
  send('channel.41', EV + 'ChatMoveToSupportedChannelEvent', { slug: 'alpha', hosted: { slug: 'gamma', username: 'Gamma' } });
  var went = null, realPlay = play;
  play = function (slug) { went = slug; };
  document.getElementById('raid-next-go').click();
  play = realPlay;
  assert(went === 'gamma' && !visible('raid-next'), 'Go now follows the raid');

  // Chat off with raid follow on: the window closes, the socket stays
  var socket = chat.ws;
  toggleChat();
  assert(!chatEl().classList.contains('on') && chat.ws === socket && socket.readyState === 1, 'closing chat keeps the socket for raid follow');
  toggleChat();
  assert(chatEl().classList.contains('on') && chat.ws === socket, 'and reopening chat reuses it');

  // Past video: the same window, fed by the replay
  disconnectChat();
  state.current = null;
  state.vod = { slug: 'alpha', startMs: Date.now() - 600000, resumeAt: 0, resumeApplied: true, name: 'Alpha', title: 'Past stream' };
  settings.chat = true;
  syncChat();
  assert(chatEl().classList.contains('on') && chatReplay.on && !chat.ws, 'a past video opens chat as a replay, without a socket');
  queueReplayMessages([message('r1', 5, 'from the recording', { created_at: new Date(state.vod.startMs + 1000).toISOString() })]);
  chatReplay.lastAt = Date.now(); chatReplay.lastPos = state.vod.startMs + 5000;
  var item = chatReplay.pending.shift(); addChatMessage(item.data, item.at);
  await drained();
  assert(texts().join('|') === 'viewer5: from the recording', 'replayed messages render like live ones');
  toggleChat();
  assert(!chatEl().classList.contains('on') && !chatReplay.on, 'Green closes the replay');
  state.vod = null; state.current = 'alpha';
  settings.raidFollow = false; disconnectChat();
};
