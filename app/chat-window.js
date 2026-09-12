/* Floating chat layout and pointer interaction, kept separate from the chat
   connection. ES5 for the TV. All coordinates use the app's 1920 x 1080 canvas. */
var ChatWindow = (function () {
  var KEY = 'kicktv.chatwindow', MIN_W = 320, MIN_H = 240;
  var rect = null, floating = null, dock = null, gesture = null, frame = null, tailFrame = null;
  var following = true, unread = 0, suppressUntil = 0, initialized = false, hovered = false;
  var autoLiveTimer = null;
  var activeChannel = '', fallback = null, layouts = Object.create(null), layoutOrder = [];
  function el(id) { return document.getElementById(id); }
  function copy(r) { return { x: r.x, y: r.y, w: r.w, h: r.h }; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function valid(r) {
    return r && ['x', 'y', 'w', 'h'].every(function (k) { return typeof r[k] === 'number' && isFinite(r[k]); });
  }
  function bounded(r) {
    var w = Math.round(clamp(r.w, MIN_W, 1000)), h = Math.round(clamp(r.h, MIN_H, 1080));
    return { x: Math.round(clamp(r.x, 0, 1920 - w)),
      y: Math.round(clamp(r.y, 0, 1080 - h)), w: w, h: h };
  }
  function defaultRect() {
    return { x: 1436, y: 140, w: 460, h: 620 };
  }
  function snapshot() {
    var saved = copy(rect);
    saved.dock = dock;
    saved.floating = copy(floating || rect);
    return saved;
  }
  function restore(saved) {
    rect = bounded(valid(saved) ? saved : defaultRect());
    dock = saved && (saved.dock === 'left' || saved.dock === 'right') ? saved.dock : null;
    floating = bounded(saved && valid(saved.floating) ? saved.floating : rect);
    if (dock) dockRect(dock);
  }
  function dockRect(side) {
    dock = side;
    rect.x = side === 'left' ? 0 : 1920 - rect.w;
    rect.y = 0; rect.h = 1080;
  }
  function selectChannel() {
    var channel = state.current || (state.vod && state.vod.slug) || '';
    if (channel === activeChannel && rect) return;
    finish(true);
    cancelAutoLive();
    activeChannel = channel;
    restore(channel && layouts[channel] ? layouts[channel] : fallback);
  }
  function save() {
    if (activeChannel) {
      layouts[activeChannel] = snapshot();
      var idx = layoutOrder.indexOf(activeChannel);
      if (idx !== -1) layoutOrder.splice(idx, 1);
      layoutOrder.push(activeChannel);
      while (layoutOrder.length > 100) delete layouts[layoutOrder.shift()];
    } else fallback = snapshot();
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 2, fallback: fallback, layouts: layouts, order: layoutOrder }));
    } catch (e) {}
  }
  function focusControls(on) {
    hovered = !!on;
    el('chat').classList.toggle('focused', hovered || !!gesture);
    updateAutoLive();
  }
  function cancelAutoLive() {
    if (autoLiveTimer !== null) { clearTimeout(autoLiveTimer); autoLiveTimer = null; }
  }
  function updateAutoLive() {
    if (following || hovered || gesture || !el('chat').classList.contains('on')) {
      cancelAutoLive(); return;
    }
    // Keep the original deadline when messages arrive or the window repaints.
    if (autoLiveTimer !== null) return;
    autoLiveTimer = setTimeout(function () {
      autoLiveTimer = null;
      if (!following && !hovered && !gesture && el('chat').classList.contains('on')) jumpToLive();
    }, 5000);
  }
  function fitVideo() {
    var separate = !!(settings.chatSeparate && dock && el('chat').classList.contains('on'));
    var left = separate && dock === 'left' ? rect.w : 0;
    var width = separate ? 1920 - rect.w : 1920;
    // Resize the native video element itself so the TV's hardware plane follows.
    // Letterbox inside the remaining space without cropping or restarting playback.
    ['video', 'poster'].forEach(function (id) {
      var layer = el(id);
      if (!layer) return;
      if (layer.style.left !== left + 'px') layer.style.left = left + 'px';
      if (layer.style.width !== width + 'px') layer.style.width = width + 'px';
    });
  }
  function paint() {
    if (!rect) rect = defaultRect();
    var box = el('chat');
    box.style.transform = 'translate(' + rect.x + 'px,' + rect.y + 'px)';
    if (box.style.width !== rect.w + 'px') box.style.width = rect.w + 'px';
    if (box.style.height !== rect.h + 'px') box.style.height = rect.h + 'px';
    box.classList.toggle('compact', rect.w < 460);
    box.classList.toggle('docked', !!dock);
    box.classList.toggle('tools-right', rect.x < 90);
    box.setAttribute('data-dock', dock || '');
    focusControls(hovered);
    fitVideo();
  }
  function updateJump() {
    var jump = el('chat-jump');
    jump.className = following ? 'hidden' : '';
    jump.textContent = unread ? 'Jump to live (' + Math.min(unread, 999) + ')' : 'Jump to live';
  }
  function followTail() {
    if (!following || tailFrame !== null) return;
    tailFrame = requestAnimationFrame(function () {
      tailFrame = null;
      if (following) { var sc = el('chat-scroll'); sc.scrollTop = sc.scrollHeight; }
    });
  }
  function jumpToLive() { cancelAutoLive(); following = true; unread = 0; updateJump(); followTail(); }
  function resetMessages() {
    cancelAutoLive();
    following = true; unread = 0;
    if (tailFrame !== null) { cancelAnimationFrame(tailFrame); tailFrame = null; }
    updateJump();
  }
  function status(value, message) {
    if (el('chat').getAttribute('data-status') !== value) el('chat').setAttribute('data-status', value);
    var notice = el('chat-status');
    if (value !== 'reconnecting' && value !== 'unavailable') {
      if (notice) notice.parentNode.removeChild(notice);
      return;
    }
    var box = el('chat-messages');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'chat-status'; notice.className = 'cmsg chat-notice';
      notice.setAttribute('role', 'status'); box.appendChild(notice);
      while (box.children.length > CHAT_MAX) box.removeChild(box.firstChild);
    }
    notice.textContent = value === 'reconnecting' ? 'Chat disconnected. Retrying...' : 'Chat disconnected.';
    followTail();
  }
  function show() {
    selectChannel();
    paint();
    var c = state.current && state.channels[state.current];
    el('chat').setAttribute('aria-label', 'Live chat' + (c ? ': ' + (c.name || c.slug) : ''));
    followTail();
  }
  function snapHint(side, r) {
    var hint = el('chat-snap');
    hint.className = side ? '' : 'hidden';
    if (!side) return;
    hint.setAttribute('data-label', side === 'left' ? 'Dock left' : 'Dock right');
    hint.style.transform = 'translate(' + (side === 'left' ? 0 : 1920 - r.w) + 'px,0px)';
    hint.style.width = r.w + 'px'; hint.style.height = '1080px';
  }
  function applyGesture() {
    frame = null;
    if (!gesture) return;
    var g = gesture, dx = g.px - g.sx, dy = g.py - g.sy, r = copy(g.start);
    if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (!g.moved) return;
    if (g.kind === 'move') {
      if (g.layout.dock) {
        r = copy(g.layout.floating);
        r.x = g.px - g.grabX * r.w;
        r.y = g.py - g.grabY * r.h;
      } else { r.x += dx; r.y += dy; }
      dock = null;
      g.snap = g.px <= 48 || r.x <= 24 ? 'left' : (g.px >= 1872 || r.x + r.w >= 1896 ? 'right' : null);
      rect = bounded(r); snapHint(g.snap, rect);
    } else if (g.layout.dock) {
      // Docked chat stays full height. The inside divider and corners adjust width.
      var west = g.kind === 'edge' ? g.layout.dock === 'right' : g.kind.indexOf('w') !== -1;
      rect.w = clamp(g.start.w + (west ? -dx : dx), MIN_W, 1000);
      dockRect(g.layout.dock);
    } else {
      dock = null;
      if (g.kind.indexOf('w') !== -1) {
        r.x = clamp(r.x + dx, Math.max(0, g.start.x + g.start.w - 1000), g.start.x + g.start.w - MIN_W);
        r.w = g.start.x + g.start.w - r.x;
      } else r.w = clamp(r.w + dx, MIN_W, Math.min(1000, 1920 - r.x));
      if (g.kind.indexOf('n') !== -1) {
        r.y = clamp(r.y + dy, 0, g.start.y + g.start.h - MIN_H);
        r.h = g.start.y + g.start.h - r.y;
      } else r.h = clamp(r.h + dy, MIN_H, 1080 - r.y);
      rect = bounded(r);
    }
    paint();
    if (g.kind !== 'move') followTail();
  }
  function finish(cancel) {
    if (!gesture) return;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    applyGesture();
    var g = gesture;
    if (cancel) restore(g.layout);
    else if (g.moved) {
      if (g.kind === 'move' && g.snap) {
        // Keep the last free window so dragging out of a full-height dock restores it.
        floating = g.layout.dock ? copy(g.layout.floating) : copy(rect);
        dockRect(g.snap);
      } else if (g.kind !== 'move' && g.layout.dock) {
        floating.w = rect.w;
        floating = bounded(floating);
        dockRect(g.layout.dock);
      } else { dock = null; floating = copy(rect); }
    }
    gesture = null;
    el('chat').classList.remove('adjusting');
    snapHint(null);
    hovered = !cancel && g.px >= rect.x && g.px <= rect.x + rect.w && g.py >= rect.y && g.py <= rect.y + rect.h;
    paint();
    var tools = el('chat-tools').getBoundingClientRect();
    if (!cancel && g.px >= tools.left && g.px <= tools.right && g.py >= tools.top && g.py <= tools.bottom) focusControls(true);
    if (!cancel && g.moved) save();
    if (g.moved) suppressUntil = Date.now() + 350;
    if (g.target.releasePointerCapture && g.pointerId != null) {
      try { g.target.releasePointerCapture(g.pointerId); } catch (e) {}
    }
  }
  function start(e, kind) {
    if (gesture || (e.button != null && e.button !== 0)) return;
    e.preventDefault(); e.stopPropagation(); markInput(); showCursor();
    gesture = { kind: kind, start: copy(rect), layout: snapshot(), sx: e.clientX, sy: e.clientY,
      grabX: clamp((e.clientX - rect.x) / rect.w, 0, 1), grabY: clamp((e.clientY - rect.y) / rect.h, 0, 1),
      px: e.clientX, py: e.clientY, moved: false, snap: null, target: e.currentTarget, pointerId: e.pointerId };
    focusControls(true);
    el('chat').classList.add('adjusting');
    if (e.currentTarget.setPointerCapture && e.pointerId != null) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (ignore) {}
    }
  }
  function move(e) {
    if (!gesture || (gesture.pointerId != null && e.pointerId !== gesture.pointerId)) return;
    if (e.buttons === 0) { finish(false); return; }
    e.preventDefault(); e.stopPropagation(); markInput();
    gesture.px = e.clientX; gesture.py = e.clientY;
    if (frame === null) frame = requestAnimationFrame(applyGesture);
  }
  function init() {
    if (initialized) return;
    initialized = true;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    fallback = defaultRect();
    if (saved && saved.version === 2 && saved.layouts) {
      if (valid(saved.fallback)) fallback = saved.fallback;
      (Array.isArray(saved.order) ? saved.order : Object.keys(saved.layouts)).slice(-100).forEach(function (key) {
        if (typeof key === 'string' && valid(saved.layouts[key]) && layoutOrder.indexOf(key) === -1) {
          layouts[key] = saved.layouts[key]; layoutOrder.push(key);
        }
      });
    } else if (valid(saved)) fallback = saved; // migrate the previous shared window
    selectChannel();
    paint();
    var pointer = !!window.PointerEvent;
    var down = pointer ? 'pointerdown' : 'mousedown';
    var box = el('chat');
    box.addEventListener(down, function (e) {
      var target = e.target, kind = 'move';
      while (target && target !== box) {
        if (target.tagName === 'BUTTON') return;
        if (target.getAttribute && target.getAttribute('data-resize')) { kind = target.getAttribute('data-resize'); break; }
        target = target.parentNode;
      }
      if (kind === 'move' && e.target === el('chat-scroll') && e.clientX > rect.x + rect.w - 8) return;
      start(e, kind);
    });
    box.addEventListener('lostpointercapture', function () { finish(false); });
    document.addEventListener(pointer ? 'pointermove' : 'mousemove', move, true);
    document.addEventListener(pointer ? 'pointerup' : 'mouseup', function (e) {
      if (!gesture || (gesture.pointerId != null && e.pointerId !== gesture.pointerId)) return;
      gesture.px = e.clientX; gesture.py = e.clientY;
      e.preventDefault(); e.stopPropagation(); finish(false);
    }, true);
    document.addEventListener('pointercancel', function () { finish(true); }, true);
    window.addEventListener('blur', function () { finish(true); focusControls(false); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) { finish(true); focusControls(false); } });
    document.addEventListener('keydown', function () { focusControls(false); });
    document.addEventListener('click', function (e) {
      if (Date.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    box.addEventListener('mouseenter', function () { focusControls(true); });
    box.addEventListener('mouseleave', function () { focusControls(false); });
    ['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'wheel'].forEach(function (type) {
      box.addEventListener(type, function (e) {
        e.stopPropagation(); markInput();
        if (type === 'mousemove' || type === 'wheel') { showCursor(); focusControls(true); }
      });
    });
    ['chat-options', 'chat-close', 'chat-jump'].forEach(function (id) {
      el(id).addEventListener('mousedown', function (e) { e.preventDefault(); });
    });
    el('chat-options').addEventListener('click', function () { openChatOpt(); });
    el('chat-close').addEventListener('click', function () { toggleChat(); });
    el('chat-jump').addEventListener('click', jumpToLive);
    el('chat-scroll').addEventListener('scroll', function () {
      following = this.scrollHeight - this.scrollTop - this.clientHeight < 32;
      if (following) unread = 0;
      updateJump();
      updateAutoLive();
    });
    // A slow-loading emote may grow an older row after the initial append.
    box.addEventListener('load', followTail, true);
    box.addEventListener('error', followTail, true);
  }
  return {
    init: init, show: show, paint: paint, status: status,
    hide: function () { finish(true); focusControls(false); cancelAutoLive(); fitVideo(); if (tailFrame !== null) cancelAnimationFrame(tailFrame); tailFrame = null; },
    clear: resetMessages,
    reading: function () { return !following || !!gesture; },
    activePointer: function (target) { return !!gesture || Date.now() < suppressUntil || el('chat').contains(target); },
    messageAdded: function () {
      if (following) followTail(); else { unread++; updateJump(); }
    },
    side: function () { return rect && rect.x + rect.w / 2 < 960 ? 'left' : 'right'; },
    reset: function () { finish(true); restore(defaultRect()); paint(); save(); followTail(); }
  };
})();
