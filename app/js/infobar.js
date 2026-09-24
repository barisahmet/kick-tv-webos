'use strict';
/* The info bar at the top */
var overlayTimer = null;
function setOverlayAvatar(avatarUrl, name) {
  var av = document.getElementById('ov-avatar');
  if (!av) return;
  if (avatarUrl) { av.style.backgroundImage = 'url(' + avatarUrl + ')'; av.textContent = ''; }
  else { av.style.backgroundImage = ''; av.textContent = (name || '?').charAt(0).toUpperCase(); }
}
function fillOverlay(c) {
  vodOverlayKey = '';
  setOverlayAvatar(c.avatar, c.name);
  document.getElementById('ov-name').textContent = c.name;
  var up = c.live && c.startedAt ? fmtUptime(c.startedAt) : '';
  document.getElementById('ov-viewers').textContent =
    c.live ? (fmtViewers(c.viewers) + ' viewers' + (up ? ' · ' + up : '')) : 'Offline';
  // The category is a clickable chip: clicking it opens Browse filtered to it.
  var titleEl = document.getElementById('ov-title');
  titleEl.innerHTML = '';
  if (c.category) {
    var cat = document.createElement('span');
    cat.className = 'ovcat';
    if (c.categorySlug) cat.setAttribute('data-catslug', c.categorySlug);
    cat.textContent = c.category;
    titleEl.appendChild(cat);
    if (c.title) titleEl.appendChild(document.createTextNode(' · ' + c.title));
  } else titleEl.textContent = c.title || '';
}
function showOverlay(c) {
  fillOverlay(c);
  document.getElementById('ov-live').style.display = '';   // restore the LIVE badge (VOD hides it)
  var ov = document.getElementById('overlay');
  ov.style.left = state.sidebarOpen ? '470px' : '0';
  ov.style.width = state.sidebarOpen ? '1450px' : '1920px';
  ov.className = '';
  showLiveBar(false);
  armLiveOverlayHide();
}
function armLiveOverlayHide() {
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(function () {
    if (state.sidebarOpen) return;                     // with the sidebar open it hides on close instead
    // still seeking, or the pointer is resting on the bar
    if (liveSeek.base !== null || liveBar.dragTarget !== null || liveBar.hover || catPop.hover) { armLiveOverlayHide(); return; }
    document.getElementById('overlay').className = 'hidden';
    hideLiveBar();
  }, liveBar.focused ? 6000 : 4000);
}
/* Block the playing category from the top bar. Resting the pointer on the category
   chip opens a small "Block category" button under it; the bar stays up while the
   pointer is on either, and a short grace lets the pointer cross the gap. */
var catPop = { hover: false, timer: null, slug: '', name: '' };
function showCatPop(chip) {
  var pop = document.getElementById('ovcat-pop'), ov = document.getElementById('overlay');
  if (!pop || !ov) return;
  clearTimeout(catPop.timer);
  catPop.hover = true;
  catPop.slug = chip.getAttribute('data-catslug');
  catPop.name = chip.textContent;
  var blocked = isCatBlocked(catPop.slug);
  pop.innerHTML = blockIcon();
  pop.appendChild(document.createTextNode(blocked ? 'Unblock category' : 'Block category'));
  pop.className = blocked ? 'unblock' : '';
  var r = chip.getBoundingClientRect(), o = ov.getBoundingClientRect();
  pop.style.left = Math.round(r.left - o.left) + 'px';
  pop.style.top = Math.round(r.bottom - o.top + 10) + 'px';
}
function leaveCatPop() {
  clearTimeout(catPop.timer);
  catPop.timer = setTimeout(hideCatPop, 250);
}
function hideCatPop() {
  clearTimeout(catPop.timer);
  catPop.hover = false;
  var pop = document.getElementById('ovcat-pop');
  if (pop && pop.className !== 'hidden') pop.className = 'hidden';
}
// OK on a live stream: the info bar comes up with the timeline focused, so
// Left/Right seek; OK again (or Back) puts it all away.
function toggleOverlay() {
  var ov = document.getElementById('overlay');
  if (ov.className === 'hidden') {
    var c = state.channels[state.current];
    if (c) { liveBar.focused = true; showOverlay(c); }
  } else if (liveSeek.base !== null) applyLiveSeek();
  else if (!liveBar.focused && liveBarVisible()) {   // up from a channel switch: take the timeline
    liveBar.focused = true;
    showOverlay(state.channels[state.current]);
  }
  else { ov.className = 'hidden'; clearTimeout(overlayTimer); hideLiveBar(); }
}

