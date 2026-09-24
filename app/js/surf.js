'use strict';
/* Live-channels popup (Channel Up/Down): a quick surf list of the channels that
   are live right now. It never appears when nothing is live. OK plays the
   highlighted one; it auto-hides after a few seconds. */
var chpop = { open: false, list: [], idx: 0, timer: null, persistent: false };
var chpopPreviewCard = makePreviewCard('chpoppreview',
  function () { return chpop.open ? chpop.list[chpop.idx] : null; },
  function (e) {
    var box = document.getElementById('chpop-list');
    var row = box.children[chpop.idx];
    positionStreamPreview(e, row, document.getElementById('chpop-panel'));
  });
function liveList() {
  var out = [];
  state.order.forEach(function (s) { if (state.channels[s] && state.channels[s].live) out.push(s); });
  return out;
}
function chpopMove(dir) {
  chpop.persistent = false;                 // the user is here — normal auto-hide applies again
  var live = liveList();
  if (!live.length) return;                 // nothing live: do not show
  var rebuild = true;
  if (!chpop.open) {
    chpop.open = true;
    showCursor();
    document.getElementById('chpop').className = '';
    chpop.list = live;
    var ci = state.current ? live.indexOf(state.current) : -1;
    chpop.idx = ci >= 0 ? ci : 0;
    prefetchSidePreviews();               // warm thumbnails for the surf list too
  } else {
    // The rows on screen belong to the previous list. Rebuild only when the live set
    // really changed; surfing through an unchanged list just moves the highlight.
    rebuild = chpop.list.join() !== live.join();
    chpop.list = live;
    if (chpop.idx >= live.length) chpop.idx = live.length - 1;
  }
  var n = chpop.idx + dir;
  if (n < 0) n = live.length - 1;
  else if (n >= live.length) n = 0;
  chpop.idx = n;
  if (rebuild) renderChpop(); else applyChpopFocus();
  resetChpopTimer();
}
var chpopFocusEl = null;
// data-base carries the blocked-category dimming
function chpopRowBaseOf(row) { return row.getAttribute('data-base') || 'chrow'; }
// Surfing channels is rapid-fire input, and rebuilding the list per press re-assigns
// every avatar background — which a TV can visibly re-raster. Move the highlight only.
function applyChpopFocus() {
  var box = document.getElementById('chpop-list');
  var el = box.children[chpop.idx] || null;
  chpopFocusEl = swapFocus(box, chpopFocusEl, el, chpopRowBaseOf, true);
  scrollIntoViewport(box, el, 6);
  chpopPreviewCard.update();
}
function renderChpop() {
  var box = document.getElementById('chpop-list');
  box.innerHTML = '';
  chpop.list.forEach(function (slug, i) {
    var c = state.channels[slug] || {};
    var row = document.createElement('div');
    var base = 'chrow' + (isChannelBlocked(c) ? ' blocked' : '');
    row.className = base;
    row.setAttribute('data-base', base);
    row.setAttribute('data-idx', i);
    var av = document.createElement('div');
    av.className = 'chav';
    if (c.avatar) av.style.backgroundImage = 'url(' + c.avatar + ')';
    else av.textContent = (c.name || slug).charAt(0).toUpperCase();
    row.appendChild(av);
    var mid = document.createElement('div');
    mid.className = 'chmid';
    mid.innerHTML = '<div class="chname"></div><div class="chgame"><span class="chcat"></span><span class="chtitle"></span></div>';
    mid.children[0].textContent = c.name || slug;
    mid.children[1].children[0].textContent = c.category || 'Live';
    mid.children[1].children[1].textContent = c.title ? ' · ' + c.title : '';
    row.appendChild(mid);
    var vw = document.createElement('span');
    vw.className = 'chview';
    vw.innerHTML = '<span class="chdot"></span>';
    vw.appendChild(document.createTextNode(fmtViewers(c.viewers || 0)));
    row.appendChild(vw);
    box.appendChild(row);
  });
  clipChpopText(box);
  applyChpopFocus();
}
// Same hand-made ".." as the sidebar (the TV draws the browser's ellipsis badly).
// All widths are read in one pass, then the text is written.
function clipChpopText(box) {
  var names = box.querySelectorAll('.chname'), games = box.querySelectorAll('.chgame');
  if (!names.length) return;
  var nameFont = fontOf(names[0]), catFont = fontOf(games[0].children[0]), restFont = fontOf(games[0].children[1]);
  var nameW = [], gameW = [], i;
  for (i = 0; i < names.length; i++) { nameW.push(names[i].clientWidth); gameW.push(games[i].clientWidth); }
  for (i = 0; i < names.length; i++) {
    if (nameW[i] > 0) names[i].textContent = clipWithDots(names[i].textContent, nameFont, nameW[i]);
    if (gameW[i] > 0) clipTwoParts(games[i].children[0], games[i].children[1],
      games[i].children[0].textContent, games[i].children[1].textContent, catFont, restFont, gameW[i]);
  }
}
function fontOf(el) {
  var cs = getComputedStyle(el);
  return cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
}
// A category and " · title" pair sharing one line: the category keeps its room
// first and the title gets whatever is left.
function clipTwoParts(catEl, restEl, cat, rest, catFont, restFont, w) {
  var catText = cat ? clipWithDots(cat, catFont, w) : '';
  var left = w - (catText ? measureTextWidth(catText, catFont) : 0);
  var restText = rest && catText === cat && left > 0 ? clipWithDots(rest, restFont, left) : '';
  if (restText === '..') restText = '';   // no room for any of the title
  if (catEl.textContent !== catText) catEl.textContent = catText;
  if (restEl.textContent !== restText) restEl.textContent = restText;
}
function chpopActivate() {
  var slug = chpop.list[chpop.idx];
  closeChpop();
  if (slug && slug !== state.current) { closeSidebar(); play(slug); }   // same channel: just close
}
function closeChpop() {
  chpop.open = false;
  chpop.persistent = false;
  clearTimeout(chpop.timer);
  chpopPreviewCard.cancel();
  document.getElementById('chpop').className = 'hidden';
}
function resetChpopTimer() {
  if (chpop.persistent) return;        // the stream-end popup waits for the user
  clearTimeout(chpop.timer);
  chpop.timer = setTimeout(closeChpop, 4500);
}
// Opened when a stream ends with nothing auto-advancing: stays up until the
// user acts, and the 30s poll keeps its list fresh (they might be away).
function openChpopPersistent() {
  var live = liveList();
  if (!live.length || chpop.open || !state.ready) return;
  chpop.open = true;
  chpop.persistent = true;
  showCursor();
  document.getElementById('chpop').className = '';
  chpop.list = live;
  chpop.idx = 0;
  prefetchSidePreviews();
  renderChpop();
  clearTimeout(chpop.timer);           // no auto-hide
}
function refreshChpopList() {
  var live = liveList();
  if (!live.length) {                  // everyone went offline while they were away
    closeChpop();
    if (!state.current && !state.vod) showNothing();
    return;
  }
  var focused = chpop.list[chpop.idx];
  chpop.list = live;
  var fi = live.indexOf(focused);
  chpop.idx = fi >= 0 ? fi : 0;
  renderChpop();
}
function isChUp(k) { return k === 33 || k === 427; }
function isChDown(k) { return k === 34 || k === 428; }

