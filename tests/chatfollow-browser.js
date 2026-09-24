window.runChatfollowTests = async function (assert) {
  function message(i) { addChatMessage({ content: 'Message ' + i, sender: { username: 'Viewer' } }); }
  function atLive() { var sc = document.getElementById('chat-scroll'); return sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 1; }
  async function drained() {
    await fixtureUntil(function () { return !chatRenderQueue.length && chatRenderFrame === null; });
    await fixtureWait(100); // Let native scroll events and the final tail paint run.
  }
  settings.chat = true; syncChat();
  chatEl().dispatchEvent(new Event('mouseenter'));
  for (var round = 0; round < 2; round++) {
    browse.open = true;
    for (var i = 0; i < 160; i++) message(round * 160 + i);
    assert(chatRenderQueue.length === 160, 'covered chat buffers 160 messages');
    browse.open = false; flushChatRender(); await drained();
    assert(!ChatWindow.reading() && atLive(), 'chat stays at live after burst ' + round + ' without user scrolling');
    assert(chatMessagesEl().children.length === 160, 'burst rendering retains the scrollback bound');
  }
  // User scrollback between two render batches must still take precedence.
  var sc = document.getElementById('chat-scroll');
  var interrupted = false, observer = new MutationObserver(function () {
    if (interrupted) return;
    interrupted = true;
    sc.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -400 }));
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event('scroll'));
  });
  observer.observe(chatMessagesEl(), { childList: true });
  for (i = 0; i < 160; i++) message(320 + i);
  await drained(); observer.disconnect();
  assert(interrupted && ChatWindow.reading() && !atLive(), 'manual scrollback during a burst stops live following');
  document.getElementById('chat-jump').click(); await fixtureWait(100);
  assert(!ChatWindow.reading() && atLive(), 'Jump to live restores following after manual scrollback');
  message(480); await drained();
  assert(!ChatWindow.reading() && atLive(), 'later messages continue following after Jump to live');
  disconnectChat();
};
