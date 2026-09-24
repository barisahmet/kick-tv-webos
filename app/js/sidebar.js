'use strict';
/* The channel sidebar */
// Try to hide the pointer when the sidebar goes away, whether that was from Back
// or from sitting idle, and bring it back on the next real remote move. This is
// best effort. On some webOS versions cursor:none hides the system pointer and
// on others it does not, since the TV draws that pointer on top of the app. The
// important rule just keeps anything else from overriding our setting.
function hideCursor() {
  document.documentElement.classList.add('hidecursor');
}
function showCursor() {
  document.documentElement.classList.remove('hidecursor');
}
function applyPlayerToolFocus() {
  var qualityButton = document.getElementById('quality-button');
  var settingsButton = document.getElementById('settings-button');
  if (qualityButton) qualityButton.classList.toggle('focused', state.playerToolFocus === 0);
  if (settingsButton) settingsButton.classList.toggle('focused', state.playerToolFocus === 1);
  document.getElementById('wtw-button').classList.toggle('focused', state.playerToolFocus === 2);
}
function setPlayerToolFocus(idx) {
  state.playerToolFocus = idx;
  applyPlayerToolFocus();
  if (state.sidebarOpen) applySideFocus();
}
function activatePlayerTool() {
  if (state.playerToolFocus === 0) openQualityOpt();
  else if (state.playerToolFocus === 1) openSettings();
  else if (state.playerToolFocus === 2) openWhatToWatch();
}
// The bottom player tools and colour-button legend belong to the open sidebar,
// so show them exactly when it is open.
function updateGear() {
  var open = state.sidebarOpen;
  var tools = document.getElementById('player-tools');
  if (open) endQualityAlert();
  if (tools) { if (open) tools.classList.remove('hidden'); else if (!tools.classList.contains('qalert')) tools.classList.add('hidden'); }
  if (!open) {
    state.playerToolFocus = -1;
    hideQualityHint();
  }
  applyPlayerToolFocus();
  updateQualityButton();
  var guide = document.getElementById('cbguide');
  if (guide) { if (open) guide.classList.remove('hidden'); else guide.classList.add('hidden'); }
}
var sidebarRevealFrame = null;
function openSidebar() {
  if (!state.ready || browse.open || vods.open || cats.open || chpop.open) return;
  state.suppressNudgeUntil = 0;                  // an explicit reopen cancels an older Back/click grace
  showCursor();
  if (!state.sidebarOpen) {
    state.sidebarOpen = true;
    if (state.notifyCurrent) pauseNotify();
    document.getElementById('sidebar').className = 'open';
    sidePreviewArmed = !state.vod;      // in a VOD, wait for a move or a hover
    var prefer = (state.current && state.order.indexOf(state.current) !== -1)
      ? state.current : null;
    var list = document.getElementById('fav-list');
    if (!list.children.length) renderSidebar(prefer);
    else if (prefer) {
      for (var i = 0; i < state.sideItems.length; i++) {
        if (state.sideItems[i].slug === prefer) { state.sideFocus = i; break; }
      }
      applySideFocus();
    }
  }
  resetIdle();
  updateGear();
  if (sidebarRevealFrame !== null) cancelAnimationFrame(sidebarRevealFrame);
  sidebarRevealFrame = requestAnimationFrame(function () {
    sidebarRevealFrame = requestAnimationFrame(function () {
      sidebarRevealFrame = null;
      if (!state.sidebarOpen) return;
      renderSidebar();
      if (state.current && state.channels[state.current]) showOverlay(state.channels[state.current]);
      placeDiagnostics();
      prefetchSidePreviews();
      if (state.vod) showVodOverlay();
      if (Date.now() - state.lastFetch > 60000) {
        fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(); });
      }
    });
  });
}
function closeSidebar() {
  clearTimeout(state.idleTimer);
  if (vodOverlayFrame !== null) { cancelAnimationFrame(vodOverlayFrame); vodOverlayFrame = null; }
  if (sidebarRevealFrame !== null) { cancelAnimationFrame(sidebarRevealFrame); sidebarRevealFrame = null; }
  if (!state.sidebarOpen) return;
  state.sidebarOpen = false;
  state.backOpenedSidebar = false;   // however this list closed, the exit is no longer armed
  document.getElementById('sidebar').className = '';
  document.getElementById('overlay').className = 'hidden';
  hideLiveBar();
  clearTimeout(overlayTimer);
  sidePreviewCard.cancel();
  hideVodBar();                                       // VOD seek bar hides with the sidebar
  hideVodPlay();                                      // ...and so does the play/pause button
  updateGear();
  placeDiagnostics();
}
function closeSidebarWithGrace() {
  closeSidebar();
  state.suppressNudgeUntil = Date.now() + NUDGE_SUPPRESS_MS;
  hideCursor();
}
// If nothing happens for a few seconds, close the sidebar. Any action restarts the timer.
function resetIdle() {
  clearTimeout(state.idleTimer);
  if (!state.sidebarOpen) return;
  if (state.vod && (vodPointerHover || vodDragging)) return;
  if (!getFavorites().length) return;   // onboarding: keep the menu up until they add a channel
  state.idleTimer = setTimeout(function () {
    if (state.mode === 'player') { closeSidebar(); hideCursor(); }
  }, IDLE_MS);
}
// Called when the pointer moves or Left is pressed. Open the sidebar and keep it up.
function nudgeSidebar() {
  if (!state.ready || state.mode !== 'player' || browse.open || vods.open || cats.open || chpop.open) return;
  // If the user just clicked to hide the UI, don't let a stray pointer move pop it
  // straight back open. They can always click again to bring it up (which clears this).
  if (!state.sidebarOpen && Date.now() < state.suppressNudgeUntil) return;
  if (!state.sidebarOpen) openSidebar(); else resetIdle();
}
function focusKeyOf(item) {
  if (!item) return null;
  if (item.type === 'add') return 'add';
  if (item.type === 'offline-group') return 'offline-group';
  return item.slug;
}
function moveSide(delta) {
  if (!state.sideItems.length) return;
  var next = state.sideFocus + delta;
  if (next < 0 || next >= state.sideItems.length) return;
  state.sideFocus = next;
  armSidePreview();          // a deliberate move is what earns the preview in a VOD
  applySideFocus();
}
/* Moving the highlight.
   The obvious way is to rewrite every child's className and let the right one come out
   focused. That dirties the style of the whole list, and the offsetTop read that follows
   then forces a recalc and layout across all of it — on every D-pad press, and on every
   pointer move that crosses a row. In a deep Browse grid that is hundreds of cards per
   keypress, which is exactly where the user is holding the button down.
   Only two elements ever change: the one losing focus and the one gaining it. These
   helpers touch only those two. The node losing focus is remembered rather than its
   index, because a re-render replaces the children — and a node that is no longer in
   the container does not need clearing, which makes this self-correcting. */
/* Chromium 87 has no string-valued text-overflow, so the trailing dots are done by
   hand — and doing it by hand also fills the box exactly, instead of the browser
   dropping a whole character to make room for a "…". Measuring on a canvas keeps
   it off the layout path; thirty-eight rows measured twice would otherwise be a
   reflow apiece. */
var textMeasureCtx = null;
function measureTextWidth(s, font) {
  if (!textMeasureCtx) textMeasureCtx = document.createElement('canvas').getContext('2d');
  textMeasureCtx.font = font;
  return textMeasureCtx.measureText(s).width;
}
function clipWithDots(text, font, maxPx) {
  text = String(text == null ? '' : text);
  if (maxPx <= 0 || measureTextWidth(text, font) <= maxPx) return text;
  var dots = '..';
  var budget = maxPx - measureTextWidth(dots, font);
  if (budget <= 0) return dots;
  var lo = 0, hi = text.length;                  // longest prefix that still fits
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (measureTextWidth(text.slice(0, mid), font) <= budget) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).replace(/[\s·]+$/, '') + dots;
}
var sideTextStyle = null;
// The sidebar has fixed fonts, so read those once. Widths depend on the row: one with
// a viewer count or pin marker stops short of it. Read every width in one batch
// before writing any text, and only clip a value whose text or width changed. Keep
// the original so refreshing never clips its own dots.
// The second line is two spans, category then " · title", in different fonts. The
// category keeps its room first; the title gets whatever is left.
function clipSidebarText() {
  var list = document.getElementById('fav-list');
  if (!sideTextStyle) {
    var probe = list.querySelector('.favname');
    if (!probe || probe.clientWidth <= 0) return;
    // Finish reading styles before writing any text.
    var fonts = {};
    ['.favname', '.favcat', '.favtitle'].forEach(function (sel) {
      var cs = getComputedStyle(list.querySelector(sel));
      fonts[sel] = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    });
    sideTextStyle = { fonts: fonts };
  }
  var f = sideTextStyle.fonts;
  var names = list.querySelectorAll('.favname'), subs = list.querySelectorAll('.favgame');
  var nameW = [], subW = [], i;
  for (i = 0; i < names.length; i++) nameW.push(names[i].clientWidth);
  for (i = 0; i < subs.length; i++) subW.push(subs[i].clientWidth);
  for (i = 0; i < names.length; i++) {
    var el = names[i], w = nameW[i], full = el.getAttribute('data-full');
    if (w <= 0) continue;
    if (full === null) { full = el.textContent; el.setAttribute('data-full', full); }
    var key = full + '\n' + w;
    if (el._sideClipKey === key) continue;
    var clipped = clipWithDots(full, f['.favname'], w);
    if (el.textContent !== clipped) el.textContent = clipped;
    el._sideClipKey = key;
  }
  for (i = 0; i < subs.length; i++) {
    var sub = subs[i], sw = subW[i];
    if (sw <= 0 || !sub._sideParts) continue;
    var skey = sub.getAttribute('data-full') + '\n' + sw;
    if (sub._sideClipKey === skey) continue;
    clipTwoParts(sub.children[0], sub.children[1], sub._sideParts.cat, sub._sideParts.rest,
      f['.favcat'], f['.favtitle'], sw);
    sub._sideClipKey = skey;
  }
}
function swapFocus(container, prevEl, nextEl, baseOf, wantFocus) {
  if (prevEl && prevEl !== nextEl && prevEl.parentNode === container) {
    var prevClass = baseOf(prevEl);
    if (prevEl.className !== prevClass) prevEl.className = prevClass;
  }
  if (nextEl) {
    var nextClass = baseOf(nextEl) + (wantFocus ? ' focused' : '');
    if (nextEl.className !== nextClass) nextEl.className = nextClass;
  }
  return nextEl;
}
// Keep a focused row in view by the shared rule (revealScroll, virtual-grid.js).
function scrollIntoViewport(container, el, pad) {
  if (!el) return;
  var scroll = container.scrollTop;
  var next = revealScroll(scroll, container.clientHeight, el.offsetTop - container.offsetTop, el.offsetHeight, pad);
  if (next !== scroll) container.scrollTop = next;
}
var sideFocusEl = null;
var sideLayout = null;
// Row sizes do not change on focus or metadata refresh. Read their positions in
// one batch after membership/order changes, before the focus styles are written.
function measureSideLayout(list) {
  var height = list.clientHeight;
  if (!height) { sideLayout = null; return; }
  var origin = list.offsetTop, rows = [];
  for (var i = 0; i < list.children.length; i++) {
    var row = list.children[i];
    rows.push({ top: row.offsetTop - origin, height: row.offsetHeight });
  }
  sideLayout = { height: height, maxScroll: Math.max(0, list.scrollHeight - height), rows: rows };
}
function sideBaseOf(row) { return row.getAttribute('data-base') || 'favrow'; }
function applySideFocus() {
  var list = document.getElementById('fav-list');
  var row = list.children[state.sideFocus] || null;
  if (!sideLayout) measureSideLayout(list);
  var pos = sideLayout && sideLayout.rows[state.sideFocus];
  // Read scrollTop before changing either row's style; wheel scrolling remains
  // the source of truth without remeasuring every row on each keypress.
  var scroll = list.scrollTop, nextScroll = scroll;
  if (pos) {
    nextScroll = revealScroll(scroll, sideLayout.height, pos.top, pos.height, 8);
    if (nextScroll !== scroll) nextScroll = Math.max(0, Math.min(sideLayout.maxScroll, nextScroll));
  }
  sideFocusEl = swapFocus(list, sideFocusEl, row, sideBaseOf, state.playerToolFocus < 0);
  if (nextScroll !== scroll) list.scrollTop = nextScroll;
  if (state.sidebarOpen) scheduleSidePreview();
}
/* Live thumbnail previews. A card shows the stream's current frame beside the
   focused list row — used by the sidebar and the quick-switch popup. The window
   appears instantly with a loading spinner; the frame swaps in when loaded
   (usually at once, thanks to prefetching). */
var previewCache = {};   // slug -> { t, url, bitmap, img, ready }; v1 thumbnails live on images.kick.com, which loads directly
var previewPending = Object.create(null);
var PREVIEW_REFRESH_MS = 60000;   // how old a frame may get before the warmer fetches the next one
/* The preview card's size in device pixels. Read once from the stylesheet (it is
   fixed there) and the screen's pixel ratio, so every frame is scaled to exactly
   what this TV draws — no bigger. */
var previewPx = null;
function previewTargetSize() {
  if (previewPx) return previewPx;
  var e = document.getElementById('sidepreview');
  var cs = e ? getComputedStyle(e) : null;
  var w = cs ? parseFloat(cs.width) : NaN, h = cs ? parseFloat(cs.height) : NaN;
  var radius = cs ? (parseFloat(cs.borderTopLeftRadius) || 0) - (parseFloat(cs.borderTopWidth) || 0) : 10;
  if (!(w > 0) || !(h > 0)) { w = 426; h = 240; }
  var dpr = window.devicePixelRatio || 1;
  previewPx = { w: Math.round(w * dpr), h: Math.round(h * dpr), r: Math.max(0, radius) * dpr };
  return previewPx;
}
// The v2 payload only carries a thumbnail host the webview cannot load, so ask v1
// for the images.kick.com variants and take the smallest that still covers the card.
function pickPreviewUrl(raw) {
  var t = raw && raw.livestream && raw.livestream.thumbnail;
  if (!t) return null;
  return pickSrcsetUrl(t.responsive, previewTargetSize().w) || t.url || null;
}
function previewReady(slug) {
  var c = previewCache[slug];
  return !!(c && c.ready);
}
function releasePreview(entry) {
  if (entry && entry.bitmap && entry.bitmap.close) { try { entry.bitmap.close(); } catch (e) {} }
}
/* Kick's variants come in fixed sizes. Download the one that covers the card, let
   the browser decode it as-is off the main thread (a Blob source decodes on a
   worker), then crop and shrink it to the card's exact pixels with one GPU draw.
   Measured on the TV: createImageBitmap's own resize option stalled every frame for
   ~500ms per image, while a plain decode plus a canvas draw costs no frames at all
   (bar a one-off shader compile on the first). Frames are prepared one at a time so
   a warm pass never lands as a burst. If the blob route fails, the Image is kept
   and scaled at draw time instead. */
var previewPrepQueue = [], previewPrepBusy = false;
function queuePreviewPrep(job) {
  previewPrepQueue.push(job);
  if (!previewPrepBusy) nextPreviewPrep();
}
function nextPreviewPrep() {
  var job = previewPrepQueue.shift();
  if (!job) { previewPrepBusy = false; return; }
  previewPrepBusy = true;
  job(function () { setTimeout(nextPreviewPrep, 50); });
}
function scalePreviewBitmap(full) {
  var size = previewTargetSize(), w = size.w, h = size.h, iw = full.width, ih = full.height;
  var s = Math.max(w / iw, h / ih), sw = w / s, sh = h / s;
  var canvas = window.OffscreenCanvas ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
  if (full.close) full.close();
  return canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : canvas;
}
function loadPreviewFrame(url, done) {
  var settled = false;
  function once(bitmap, img) { if (!settled) { settled = true; done(bitmap, img); } }
  function viaImage() {
    var img = new Image();
    img.onload = function () { once(null, img); };
    img.onerror = function () { once(null, null); };
    img.src = url;
  }
  if (!window.createImageBitmap) { viaImage(); return; }
  var xhr = new XMLHttpRequest();
  try {
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.timeout = 15000;
  } catch (e) { viaImage(); return; }
  xhr.onload = function () {
    if (xhr.status !== 200 || !xhr.response) { viaImage(); return; }
    var blob = xhr.response;
    queuePreviewPrep(function (next) {
      createImageBitmap(blob).then(function (full) {
        var bitmap = null;
        try { bitmap = scalePreviewBitmap(full); } catch (e) { logError(e); }
        next();
        if (bitmap) once(bitmap, null); else viaImage();
      }, function () { next(); viaImage(); });
    });
  };
  xhr.onerror = xhr.ontimeout = viaImage;
  xhr.send();
}
/* Resolve a channel's current frame AND prepare it, then swap it into the cache.
   Each new frame has its own versionId in the URL. Until the new one is ready the
   cache keeps the previous frame, so a card never waits on the network once a
   channel has been warmed. */
// `urgent` is for a frame someone is waiting on (a highlighted row that was not
// warmed yet, a Browse card); the background warmer leaves it off.
function fetchPreviewUrl(slug, done, urgent) {
  if (previewPending[slug]) { if (done) previewPending[slug].push(done); return; }
  previewPending[slug] = done ? [done] : [];
  function finish() {
    var callbacks = previewPending[slug] || [];
    delete previewPending[slug];
    callbacks.forEach(function (callback) { try { callback(); } catch (e) { logError(e); } });
  }
  serviceGet('/api/v1/channels/' + encodeURIComponent(slug), function (err, raw) {
    var url = err ? null : pickPreviewUrl(raw);
    var old = previewCache[slug];
    if (!url) { finish(); return; }
    if (old && old.url === url && old.ready) { old.t = Date.now(); finish(); return; }
    loadPreviewFrame(url, function (bitmap, img) {
      if (bitmap || img) {
        releasePreview(old);
        previewCache[slug] = { t: Date.now(), url: url, bitmap: bitmap, img: img, ready: true };
      } else if (!old) previewCache[slug] = { t: Date.now(), url: url, bitmap: null, img: null, ready: false };
      else old.t = Date.now();          // keep showing the last good frame; retry next round
      finish();
    });
  }, { priority: urgent ? 1 : 3 });  // idle: never ahead of the channel list refresh
}
// Every channel whose frame a list could show: live favourites plus a temporary one.
function previewTargets() {
  var out = [];
  for (var i = 0; i < state.order.length; i++) {
    var c = state.channels[state.order[i]];
    if (c && c.live) out.push(state.order[i]);
  }
  var t = state.tempChannel;
  if (t && state.channels[t] && state.channels[t].live && out.indexOf(t) === -1) out.push(t);
  return out;
}
// Drop frames for channels that went offline or left the list, so the cache stays
// the size of the live list instead of growing through a long evening.
function prunePreviews(keep) {
  for (var slug in previewCache) {
    if (keep.indexOf(slug) === -1 && !previewPending[slug]) { releasePreview(previewCache[slug]); delete previewCache[slug]; }
  }
}
/* Keep every live channel's frame warm in the background, on a one-minute beat,
   so opening the sidebar or surf list shows real frames at once. Stale ones only;
   the request queue runs them two at a time at background priority, behind playback. */
var previewWarmLast = 0;
function warmPreviews(force) {
  if (!state.ready || document.hidden || saver.on) return;
  if (!force && Date.now() - previewWarmLast < PREVIEW_REFRESH_MS - 5000) return;
  previewWarmLast = Date.now();
  var targets = previewTargets();
  prunePreviews(targets);
  // Whatever the viewer is about to look at goes first: the highlighted row, then
  // the list order (pinned and busiest channels are at the top).
  var focusItem = state.sidebarOpen && state.sideItems[state.sideFocus];
  if (focusItem && focusItem.slug && targets.indexOf(focusItem.slug) > 0) {
    targets.splice(targets.indexOf(focusItem.slug), 1);
    targets.unshift(focusItem.slug);
  }
  targets.forEach(function (slug) {
    var cached = previewCache[slug];
    if (!cached || Date.now() - cached.t >= PREVIEW_REFRESH_MS - 5000) fetchPreviewUrl(slug);
  });
}
// Opening a list forces a pass over anything stale (the timer may be up to a
// minute away); fresh frames are left alone, so this costs nothing when warm.
function prefetchSidePreviews() { warmPreviews(true); }
setInterval(function () { warmPreviews(false); }, PREVIEW_REFRESH_MS);
// Copy a prepared frame onto the card's canvas, clipped to the card's inner
// rounded corners (a canvas is not clipped by its parent's border-radius).
function drawPreviewFrame(card, entry) {
  var size = previewTargetSize();
  var canvas = card.querySelector('canvas.prevframe');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'prevframe';
    card.insertBefore(canvas, card.firstChild);
  }
  if (canvas.width !== size.w || canvas.height !== size.h) { canvas.width = size.w; canvas.height = size.h; }
  var ctx = canvas.getContext('2d'), w = size.w, h = size.h, r = size.r;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.arcTo(w, 0, w, r, r);
  ctx.lineTo(w, h - r); ctx.arcTo(w, h, w - r, h, r);
  ctx.lineTo(r, h); ctx.arcTo(0, h, 0, h - r, r);
  ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.clip();
  // Cover-crop. A prepared bitmap is already the card's width, so for a 16:9
  // stream this is a straight copy; anything else is scaled here as a fallback.
  var src = entry.bitmap || entry.img;
  var iw = entry.bitmap ? src.width : src.naturalWidth, ih = entry.bitmap ? src.height : src.naturalHeight;
  if (iw && ih) {
    var s = Math.max(w / iw, h / ih);
    ctx.drawImage(src, (iw - w / s) / 2, (ih - h / s) / 2, w / s, h / s, 0, 0, w, h);
  }
  ctx.restore();
}
// One controller per card element; each follows its own list's focus. Repeat
// updates for the same row are no-ops (re-renders must not flash the card).
// Where an element sits once any entrance animation has finished. The sidebar
// slides and the surf panel scales in, and a warmed preview now appears within
// that animation, so a getBoundingClientRect would pin it to the moving start
// frame. Offsets ignore transforms; scrolled ancestors are subtracted by hand.
function layoutRect(el) {
  var x = 0, y = 0, w = el.offsetWidth, h = el.offsetHeight, n = el;
  while (n) {
    x += n.offsetLeft; y += n.offsetTop;
    var p = n.offsetParent;
    for (var a = n.parentNode; a && a !== p && a.nodeType === 1; a = a.parentNode) { x -= a.scrollLeft; y -= a.scrollTop; }
    if (p) { x += p.clientLeft - p.scrollLeft; y += p.clientTop - p.scrollTop; }
    n = p;
  }
  return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}
// The card sits at 0,0 and moves by transform, so the CSS transition can glide it
// from row to row on the compositor.
function positionStreamPreview(panel, row, container) {
  if (!row || !container) return;
  var anchor = layoutRect(row), edge = layoutRect(container);
  var clip = layoutRect(row.parentNode);
  var vis = anchor.bottom <= clip.top || anchor.top >= clip.bottom ? 'hidden' : '';
  if (panel.style.visibility !== vis) panel.style.visibility = vis;
  var width = panel.offsetWidth, height = panel.offsetHeight;
  var viewWidth = window.innerWidth || 1920, viewHeight = window.innerHeight || 1080;
  var left = edge.right + 24;
  if (left + width > viewWidth - 24) left = edge.left - width - 24;
  var x = Math.round(Math.max(24, Math.min(viewWidth - width - 24, left)));
  var y = Math.round(Math.max(24, Math.min(viewHeight - height - 24, anchor.top + (anchor.height - height) / 2)));
  var transform = 'translate(' + x + 'px,' + y + 'px)';
  if (panel.style.transform !== transform) panel.style.transform = transform;
}
function makePreviewCard(elId, currentSlugFn, positionFn) {
  var slugShowing = null, urlShowing = null, timer = null, titleFont = null;
  function el() { return document.getElementById(elId); }
  function hide() {
    slugShowing = null; urlShowing = null;
    var e = el();
    if (e && e.className !== 'hidden') e.className = 'hidden';
  }
  // Show the card in a state and move it to the highlighted row. Coming out of
  // hiding it jumps straight there; while it is up it glides.
  function reveal(e, cls) {
    var wasHidden = e.className === 'hidden';
    if (e.className !== cls) e.className = cls;
    if (!wasHidden) { positionFn(e); return; }
    e.style.transition = 'none';
    positionFn(e);
    void e.offsetWidth;                 // commit the jump before transitions return
    e.style.transition = '';
  }
  function setTitle(e, slug) {
    var tEl = e.querySelector('.prevtitle');
    if (!tEl) return;
    var c = state.channels[slug];
    var title = (c && c.title) || '';
    tEl.style.display = title ? '' : 'none';
    if (!title) { tEl.textContent = ''; return; }
    // Same hand-rolled ".." as the channel list, so the two never disagree. The
    // card has a fixed size, so its font and text width are read once. It has to be
    // visible for clientWidth to read, hence the fallback.
    if (!titleFont || titleFont.w <= 0) {
      var cs = getComputedStyle(tEl);
      titleFont = { font: cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily,
        w: tEl.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) };
    }
    var clipped = titleFont.w > 0 ? clipWithDots(title, titleFont.font, titleFont.w) : title;
    if (tEl.textContent !== clipped) tEl.textContent = clipped;
  }
  function present(slug) {
    if (slugShowing !== slug || currentSlugFn() !== slug) return;   // focus moved meanwhile
    var entry = previewCache[slug];
    if (!entry || !entry.ready) return;
    var e = el();
    if (urlShowing !== entry.url || e._frameSlug !== slug) {
      drawPreviewFrame(e, entry);
      urlShowing = entry.url; e._frameSlug = slug;
    }
    reveal(e, '');
    setTitle(e, slug);
  }
  // A warmed frame is ready to draw: show it on the spot, and swap in a newer one
  // if the warmer brings it while the card is still up.
  function showWarm(slug) {
    present(slug);
    if (Date.now() - previewCache[slug].t >= PREVIEW_REFRESH_MS) {
      fetchPreviewUrl(slug, function () { if (slugShowing === slug) present(slug); });
    }
  }
  function update() {
    var slug = currentSlugFn();
    var c = slug ? state.channels[slug] : null;
    var want = !!(slug && c && c.live && slug !== state.current);
    if (want && slug === slugShowing) { if (el().className !== 'hidden') positionFn(el()); return; }
    clearTimeout(timer);
    if (!want) { hide(); return; }
    slugShowing = slug;
    if (previewReady(slug)) { showWarm(slug); return; }
    // Not warmed yet. A card already up glides along with a spinner; a hidden one
    // waits for the highlight to settle. Either way the network is only asked once
    // the highlight rests.
    var e = el();
    urlShowing = null;
    if (e.className !== 'hidden') { reveal(e, 'loading'); setTitle(e, slug); }
    timer = setTimeout(function () {
      if (currentSlugFn() !== slug) { hide(); return; }
      reveal(e, 'loading');
      setTitle(e, slug);
      fetchPreviewUrl(slug, function () {
        if (slugShowing !== slug) return;
        if (previewReady(slug)) present(slug);
        else hide();                    // no thumbnail: no stuck spinner
      }, true);
    }, 150);
  }
  return { update: update, cancel: function () { clearTimeout(timer); hide(); } };
}
var sidePreviewCard = makePreviewCard('sidepreview',
  function () {
    if (!state.sidebarOpen || settings.open || qualityopt.open || chatopt.open) return null;
    var item = state.sideItems[state.sideFocus];
    return (item && (item.type === 'chan' || item.type === 'temp')) ? item.slug : null;
  },
  function (e) {
    var list = document.getElementById('fav-list');
    var row = list.children[state.sideFocus];
    positionStreamPreview(e, row, document.getElementById('sidebar'));
  });
/* Over a VOD the preview window lands on top of the transport controls, which ride with
   the sidebar. So in a VOD the preview is not armed by merely opening the list — it waits
   until the highlight actually moves or the pointer lands on a row. Live playback is
   unaffected: there are no controls underneath to cover. */
var sidePreviewArmed = true;
function armSidePreview() { sidePreviewArmed = true; }
function scheduleSidePreview() {
  if (!sidePreviewArmed) { sidePreviewCard.cancel(); return; }
  sidePreviewCard.update();
}
var sideRows = Object.create(null);
var sidePrepareTimer = null;
function prepareSidebarSoon() {
  if (sidePrepareTimer || !state.ready || document.hidden || state.sidebarOpen) return;
  // Let startup/playback and the refresh callbacks finish before preparing UI.
  sidePrepareTimer = setTimeout(function () {
    sidePrepareTimer = null;
    if (!document.hidden && !state.sidebarOpen) renderSidebar();
  }, 500);
}
// The second line: an optional category span and the rest in title colour.
function setSideSub(el, cat, rest) {
  var full = cat + '\n' + rest;
  if (el.getAttribute('data-full') === full) return false;
  el.setAttribute('data-full', full);
  if (el.children.length !== 2) el.innerHTML = '<span class="favcat"></span><span class="favtitle"></span>';
  el.children[0].textContent = cat;
  el.children[1].textContent = rest;
  el._sideParts = { cat: cat, rest: rest };
  el._sideClipKey = null;
  return true;
}
function setSideText(el, full) {
  full = String(full == null ? '' : full);
  if (el.getAttribute('data-full') === full) return false;
  el.setAttribute('data-full', full);
  el.textContent = full;
  el._sideClipKey = null;
  return true;
}
window.addEventListener('resize', function () {
  sideTextStyle = null;
  sideLayout = null;
  if (state.ready) renderSidebar();
});
function renderSidebar(focusKey) {
  var prevKey = (typeof focusKey !== 'undefined' && focusKey !== null)
    ? focusKey : focusKeyOf(state.sideItems[state.sideFocus]);

  state.sideItems = [];
  if (state.tempChannel && state.order.indexOf(state.tempChannel) === -1 && state.channels[state.tempChannel]) {
    state.sideItems.push({ type: 'temp', slug: state.tempChannel });
  }
  if (settings.hideOffline) {
    var offline = [];
    state.order.forEach(function (s) {
      if (state.channels[s] && state.channels[s].live) state.sideItems.push({ type: 'chan', slug: s });
      else offline.push(s);
    });
    if (offline.length) {
      state.sideItems.push({ type: 'offline-group', count: offline.length });
      if (state.offlineExpanded) {
        offline.forEach(function (s) { state.sideItems.push({ type: 'chan', slug: s }); });
      }
    } else {
      state.offlineExpanded = false;
    }
  } else {
    state.order.forEach(function (s) { state.sideItems.push({ type: 'chan', slug: s }); });
  }
  state.sideItems.push({ type: 'add' });

  var cc = document.getElementById('side-count');
  var countText = state.netDown ? 'Connection lost' :
    (state.order.length ? (liveCount() + ' / ' + state.order.length + ' live') : '');
  var countClass = state.netDown ? 'neterr' : '';
  if (cc.textContent !== countText) cc.textContent = countText;
  if (cc.className !== countClass) cc.className = countClass;

  var list = document.getElementById('fav-list');
  var nextRows = Object.create(null), structureChanged = !sideLayout, textChanged = false;
  state.sideItems.forEach(function (item, index) {
    var key = item.type + ':' + (item.slug || '');
    var row = sideRows[key];
    if (item.type === 'offline-group') {
      if (!row) {
        row = document.createElement('div');
        row.setAttribute('data-base', 'favrow offlinegroup');
        row.setAttribute('data-type', 'offline-group');
        row.className = 'favrow offlinegroup';
        row.innerHTML = '<span class="offline-chevron"></span><span class="offline-label">Offline channels</span><span class="offline-count"></span>';
      }
      if (row._sideExpanded !== state.offlineExpanded) {
        row.children[0].innerHTML = state.offlineExpanded
          ? '<svg viewBox="0 0 24 24"><path d="M4 8l8 8 8-8"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M8 4l8 8-8 8"/></svg>';
        row._sideExpanded = state.offlineExpanded;
      }
      if (row.children[2].textContent !== String(item.count)) row.children[2].textContent = String(item.count);
    } else if (item.type === 'add') {
      if (!row) {
        row = document.createElement('div');
        row.setAttribute('data-base', 'favrow addrow');
        row.setAttribute('data-type', 'add');
        row.className = 'favrow addrow';
        row.innerHTML = '<span class="addplus">+</span><span class="addtext">Add channel</span>';
      }
    } else {
      var isTemp = item.type === 'temp';
      var slug = item.slug, c = state.channels[slug], pinned = !isTemp && isPinned(slug);
      // A blocked row keeps all its live information and is merely dimmed.
      var blocked = isChannelBlocked(c);
      var base = 'favrow' + (isTemp ? ' temp' : '') + (c.live ? '' : ' offline') +
                 (blocked ? ' blocked' : '') +
                 (slug === state.current ? ' current' : '') + (pinned ? ' pinned' : '');
      if (!row) {
        row = document.createElement('div');
        row.setAttribute('data-slug', slug);
        row.innerHTML = '<div class="favav"></div><div class="favmid"><div class="favname"></div><div class="favgame"></div></div><div class="favinfo"></div><div class="favactions"></div>';
      }
      if (row.getAttribute('data-base') !== base) {
        if (row.hasAttribute('data-base')) textChanged = true;   // live/pinned changes the text width
        row.setAttribute('data-base', base);
        row.className = base + (row === sideFocusEl && state.playerToolFocus < 0 ? ' focused' : '');
      }

      var av = row.children[0], avClass = 'favav' + (c.live ? '' : ' off');
      if (av.className !== avClass) av.className = avClass;
      var avatar = c.avatar || '';
      if (row._sideAvatar !== avatar) {
        av.style.backgroundImage = avatar ? 'url(' + avatar + ')' : '';
        row._sideAvatar = avatar;
      }
      var initial = avatar ? '' : (c.name || slug).charAt(0).toUpperCase();
      if (av.textContent !== initial) av.textContent = initial;

      var mid = row.children[1];
      if (setSideText(mid.children[0], c.name)) textChanged = true;
      if (c.live) {
        if (setSideSub(mid.children[1], c.category || 'Live', c.title ? ' · ' + c.title : '')) textChanged = true;
      } else if (setSideSub(mid.children[1], '', offlineLabel(slug))) textChanged = true;

      var info = row.children[2];
      var infoHtml = '';
      if (pinned) infoHtml += '<span class="pinmark">' + pinIcon() + '</span>';
      if (c.live) infoHtml += '<span class="livedot"></span><span class="favview">' + fmtViewers(c.viewers) + '</span>';
      if (row._sideInfo !== infoHtml) { info.innerHTML = infoHtml; row._sideInfo = infoHtml; }

      var act = row.children[3], actHtml;
      if (isTemp) {
        actHtml = '<span class="actbtn addbtn" data-act="addfav" title="Add to your channels">+</span>';
      } else {
        actHtml =
          '<span class="actbtn pinbtn' + (pinned ? ' on' : '') + '" data-act="pin">' + pinIcon() + '</span>' +
          '<span class="actbtn rmbtn" data-act="remove">✕</span>';
      }
      if (row._sideActions !== actHtml) { act.innerHTML = actHtml; row._sideActions = actHtml; }
    }

    nextRows[key] = row;
    if (list.children[index] !== row) {
      list.insertBefore(row, list.children[index] || null);
      structureChanged = true;
    }
  });
  while (list.children.length > state.sideItems.length) {
    list.removeChild(list.lastChild);
    structureChanged = true;
  }
  sideRows = nextRows;

  if (textChanged || !sideTextStyle) clipSidebarText();
  if (structureChanged) measureSideLayout(list);

  var idx = -1;
  for (var i = 0; i < state.sideItems.length; i++) {
    if (focusKeyOf(state.sideItems[i]) === prevKey) { idx = i; break; }
  }
  if (idx === -1 && settings.hideOffline && prevKey && state.channels[prevKey] &&
      !state.channels[prevKey].live) {
    for (var j = 0; j < state.sideItems.length; j++) {
      if (state.sideItems[j].type === 'offline-group') { idx = j; break; }
    }
  }
  state.sideFocus = idx === -1 ? 0 : idx;
  applySideFocus();

  // Show the plus in the header only when the list is long enough to scroll,
  // because then the Add row down at the bottom is out of sight.
  var addBtn = document.getElementById('side-add');
  var addClass = sideLayout && sideLayout.maxScroll > 2 ? '' : 'hidden';
  if (addBtn && addBtn.className !== addClass) addBtn.className = addClass;
  // Nothing to refresh when there are no channels, so hide that button.
  var refBtn = document.getElementById('side-refresh');
  if (refBtn && refBtn.classList.contains('hidden') !== !state.order.length)
    refBtn.classList.toggle('hidden', !state.order.length);
}
function activateSide() {
  var item = state.sideItems[state.sideFocus];
  if (!item) return;
  if (item.type === 'offline-group') {
    state.offlineExpanded = !state.offlineExpanded;
    renderSidebar('offline-group');
    resetIdle();
  } else if (item.type === 'add') openAdd();
  else switchTo(item.slug);
}
var pendingAction = null;
function askRemove(slug) {
  if (!slug || !state.channels[slug]) return;
  pendingAction = { type: 'remove', slug: slug };
  document.getElementById('confirm-text').textContent =
    'Remove ' + state.channels[slug].name + ' from favorites?';
  document.getElementById('confirm-yes').textContent = 'Remove';
  setMode('confirm');
}
function confirmYes() {
  var a = pendingAction; pendingAction = null;
  setMode('player');
  if (!a) return;
  if (a.type === 'remove' && state.channels[a.slug]) {
    var name = state.channels[a.slug].name;
    removeFavorite(a.slug);
    // Still playing: it stays in the list as a temporary row, with its add button.
    if (a.slug === state.current && !state.vod) state.tempChannel = a.slug;
    toast('Removed ' + name);
    // Sorting is local; no need to re-fetch every channel to drop one row.
    sortOrder(currentFavoritesWithData());
    if (state.sidebarOpen) renderSidebar();
    if (!state.current) showNothing();
    saveChannelCache();
  }
  resetIdle();
}
function confirmNo() {
  pendingAction = null;
  setMode('player');
  if (state.sidebarOpen) renderSidebar();
  if (!state.current) showNothing();
  resetIdle();
}
function togglePinFocused() {
  var item = state.sideItems[state.sideFocus];
  if (!item || item.type !== 'chan') return;
  var nowPinned = togglePin(item.slug);
  toast((nowPinned ? 'Pinned ' : 'Unpinned ') + state.channels[item.slug].name);
  sortOrder(currentFavoritesWithData());          // a pin only reorders; no network needed
  if (state.sidebarOpen) renderSidebar(item.slug);
  saveChannelCache();
}
// The temporary (browsed) channel row has an add icon that saves it for good.
function addTempToFavorites() {
  var slug = state.tempChannel;
  if (!slug) return;
  addFavorite(slug);
  state.tempChannel = null;
  toast('Added ' + (state.channels[slug] ? state.channels[slug].name : slug));
  fetchFavorites(function () { if (state.sidebarOpen) renderSidebar(slug); });
}
function refreshSide() {
  if (!state.sidebarOpen) openSidebar();     // show the list right away, with the spinner turning
  var btn = document.getElementById('side-refresh');
  btn.classList.add('spinning');            // keep 'hidden' under renderSidebar's control
  var done = false, minned = false;
  function stop() { if (done && minned) btn.classList.remove('spinning'); }
  setTimeout(function () { minned = true; stop(); }, 700); // keep it spinning for at least one full turn
  fetchFavorites(function () {
    if (state.sidebarOpen) renderSidebar();   // closed meanwhile: leave it closed
    if (!state.current && !state.vod) showNothing();
    done = true; stop();
  });
}

