window.runChatlayoutTests = async function (assert) {
  document.getElementById('video').style.display = 'block';
  function box() { return chatEl().getBoundingClientRect(); }
  function near(a, b) { return Math.abs(a - b) < 1; }
  function pointer(target, type, x, y, buttons) {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  }
  async function drag(x, y) {
    var r = box();
    pointer(chatEl(), 'pointerdown', r.left + r.width / 2, r.top + r.height / 2, 1);
    pointer(document, 'pointermove', x, y, 1); await fixtureWait();
    pointer(document, 'pointerup', x, y, 0);
  }
  settings.chat = true; syncChat(); ChatWindow.reset();
  var original = box(), saved = localStorage.getItem('kicktv.chatwindow');
  openSidebar(); await fixtureWait();
  var small = box(), video = document.getElementById('video').getBoundingClientRect();
  var scale = Math.min(video.width / 1920, video.height / 1080);
  var originX = video.left + (video.width - 1920 * scale) / 2;
  assert(near(small.width, original.width * scale) && near(small.height, original.height * scale), 'chat shrinks uniformly with the video');
  assert(near(small.left, originX + original.left * scale) && near(small.top, video.top + original.top * scale), 'chat stays at the same relative picture position');
  assert(localStorage.getItem('kicktv.chatwindow') === saved, 'opening sidebar preserves saved geometry');
  closeSidebar();
  assert(near(box().width, original.width) && near(box().left, original.left), 'closing sidebar restores full-size chat');
  openSidebar(); await fixtureWait();
  small = box();
  pointer(chatEl(), 'pointerdown', small.left + 50, small.top + 30, 1);
  pointer(document, 'pointermove', small.left + 20, small.top + 60, 1);
  await fixtureWait();
  pointer(document, 'pointerup', small.left + 20, small.top + 60, 0);
  assert(near(box().left, small.left - 30) && near(box().top, small.top + 30), 'scaled dragging follows the pointer without jumping');
  closeSidebar(); ChatWindow.reset();
  await drag(1800, 950);
  assert(chatEl().getAttribute('data-dock') === '' && near(box().right, 1920) && near(box().bottom, 1080), 'floating chat can reach the bottom-right corner without docking');
  await drag(120, 950);
  assert(chatEl().getAttribute('data-dock') === '' && near(box().left, 0) && near(box().bottom, 1080), 'floating chat can reach the bottom-left corner without docking');
  await drag(1919, 700);
  assert(chatEl().getAttribute('data-dock') === 'right' && near(box().height, 1080), 'pointer at right edge docks chat at full height');
  ChatWindow.reset();
  original = box();
  pointer(chatEl(), 'pointerdown', original.left + 60, original.top + 30, 1);
  pointer(document, 'pointermove', 1, original.top + 30, 1); await fixtureWait();
  pointer(document, 'pointerup', 1, original.top + 30, 0);
  assert(chatEl().getAttribute('data-dock') === 'left', 'chat can dock on the left');
  settings.chatSeparate = true; applyChatStyle();
  openSidebar(); await fixtureWait();
  small = box(); video = document.getElementById('video').getBoundingClientRect();
  assert(small.left >= 490 && small.bottom <= 831, 'docked chat fits beside sidebar inside the picture area');
  assert(near(small.right, video.left), 'separate docked chat does not cover the reduced video');
  var width = small.width;
  pointer(document.getElementById('chat-divider'), 'pointerdown', small.right - 3, small.top + 150, 1);
  pointer(document, 'pointermove', small.right + 37, small.top + 150, 1); await fixtureWait();
  pointer(document, 'pointerup', small.right + 37, small.top + 150, 0);
  assert(near(box().width, width + 40), 'scaled dock resize follows pointer distance');
  video = document.getElementById('video').getBoundingClientRect();
  assert(near(box().right, video.left), 'video follows resized dock');
  closeSidebar();
  assert(near(box().height, 1080), 'docked chat restores full height after sidebar closes');
  settings.chat = false; syncChat();
  openSidebar(); state.vod = { slug: 'alpha' }; document.getElementById('player').setAttribute('data-vod', ''); updateGear();
  video = document.getElementById('video').getBoundingClientRect();
  assert(near(video.top, 40) && near(video.height, 690), 'VOD retains its sidebar picture layout');
  state.vod = null; document.getElementById('player').removeAttribute('data-vod'); closeSidebar();
};
