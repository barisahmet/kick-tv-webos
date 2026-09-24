'use strict';
/* Remote and keyboard input */
document.addEventListener('keydown', function (e) {
  var k = e.keyCode;
  var wasSaver = saver.on;
  markInput();                                      // any key counts as activity for the burn-in guard
  if (wasSaver) { e.preventDefault(); return; }     // the first press just dismisses the screensaver
  if (!state.ready) {                               // still on the splash, ignore input until data is ready
    e.preventDefault();
    // ...except the way out. disableBackHistoryAPI means we own the Back key, so
    // swallowing it here would leave no escape if boot ever stalls.
    if (k === KEY.BACK || k === KEY.STOP) armOrExit();
    return;
  }
  if (state.vod && vodPointerHover) {
    vodPointerHover = '';     // remote input resumes timed hiding, even under a parked cursor
    if (vodBarVisible()) armVodOverlayHide();
    if (state.sidebarOpen) resetIdle();
  }
  // Anything but Back cancels a pending exit. That covers the stream -> list -> exit
  // ladder too: once you have started moving around the list, Back means "close the
  // list" again, so browsing it can never drop you out of the app by surprise.
  if (k !== KEY.BACK && k !== KEY.STOP) { state.quitArmed = false; state.backOpenedSidebar = false; }
  if (cats.open) {
    var csearch = document.getElementById('cats-search');
    if (document.activeElement === csearch) {          // typing in the search box
      if (k === KEY.BACK || k === KEY.OK) { e.preventDefault(); csearch.blur(); }
      return;                                          // let the on-screen keyboard type
    }
    e.preventDefault();
    if (k === KEY.BACK || k === KEY.YELLOW) closeCats();
    else if (k === KEY.LEFT) catsMove(-1, 0);
    else if (k === KEY.RIGHT) catsMove(1, 0);
    else if (k === KEY.UP) catsMove(0, -1);
    else if (k === KEY.DOWN) catsMove(0, 1);
    else if (k === KEY.OK) catsActivate();
    else if (k === KEY.GREEN) {                       // green pins/unpins the focused category
      if (cats.zone === 'grid' && cats.gridIdx > 0 && displayedCats()[cats.gridIdx - 1]) {
        var pc = displayedCats()[cats.gridIdx - 1];
        toggleCatPin(pc.slug, pc.name || pc.slug);
      }
    }
    else if (k === KEY.RED) {                         // red blocks or unblocks the focused category
      if (cats.zone === 'grid' && cats.gridIdx > 0 && displayedCats()[cats.gridIdx - 1]) {
        var bcat = displayedCats()[cats.gridIdx - 1];
        var nowBlocked = toggleCatBlock(bcat.slug, bcat.name || bcat.slug);
        toast((nowBlocked ? 'Blocked ' : 'Unblocked ') + (bcat.name || bcat.slug));
        applyBlockedChange();
      }
    }
    return;
  }
  if (browse.open) {
    e.preventDefault();
    // the dropdown swallows Back and Left first, so neither closes Browse under it
    if (browse.langMenuOpen && (k === KEY.BACK || k === KEY.LEFT || k === KEY.RIGHT)) closeBrowseLangMenu();
    else if (k === KEY.BLUE || k === KEY.BACK) closeBrowse();
    else if (k === KEY.YELLOW) openCats();               // yellow opens the categories picker
    else if (k === KEY.LEFT) browseMove(-1, 0);
    else if (k === KEY.RIGHT) browseMove(1, 0);
    else if (k === KEY.UP) browseMove(0, -1);
    else if (k === KEY.DOWN) browseMove(0, 1);
    else if (k === KEY.OK) browseActivate();
    return;
  }
  if (vods.open) {
    e.preventDefault();
    if (k === KEY.YELLOW || k === KEY.BACK) closeVods();
    else if (k === KEY.GREEN) toggleVodHideWatched();    // green hides/shows watched videos
    else if (k === KEY.LEFT) vodMove(-1, 0);
    else if (k === KEY.RIGHT) vodMove(1, 0);
    else if (k === KEY.UP) vodMove(0, -1);
    else if (k === KEY.DOWN) vodMove(0, 1);
    else if (k === KEY.OK) vodActivate();
    return;
  }
  if (updateopen) {
    e.preventDefault();
    var notes = document.getElementById('update-notes');
    if (k === KEY.UP) notes.scrollTop -= 120;
    else if (k === KEY.DOWN) notes.scrollTop += 120;
    else if (k === KEY.BACK || k === KEY.OK || k === KEY.LEFT) closeUpdateNotes();
    return;
  }
  if (wtw.open) { e.preventDefault(); wtwKey(k); return; }
  if (qualityopt.open) {
    e.preventDefault();
    if (k === KEY.BACK || k === KEY.LEFT) closeQualityOpt();
    else if (k === KEY.UP) qualityoptMove(-1);
    else if (k === KEY.DOWN) qualityoptMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) qualityoptActivate();
    return;
  }
  if (dimopt.open) {
    e.preventDefault();
    if (k === KEY.BACK) closeDimOpt();
    else if (k === KEY.UP) dimoptMove(-1);
    else if (k === KEY.DOWN) dimoptMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) dimoptActivate(1);
    else if (k === KEY.LEFT) dimoptActivate(-1);
    return;
  }
  if (chatopt.open) {
    e.preventDefault();
    if (k === KEY.BACK) closeChatOpt();
    else if (k === KEY.UP) chatoptMove(-1);
    else if (k === KEY.DOWN) chatoptMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) chatoptActivate(1);
    else if (k === KEY.LEFT) chatoptActivate(-1);
    return;
  }
  if (backup.open) { e.preventDefault(); backupKey(k); return; }
  if (blockedcats.open) {
    e.preventDefault();
    if (k === KEY.BACK) closeBlockedCats();
    else if (k === KEY.UP) blockedcatsMove(-1);
    else if (k === KEY.DOWN) blockedcatsMove(1);
    else if (k === KEY.OK || k === KEY.RIGHT) blockedcatsActivate();
    return;
  }
  if (settings.open) {
    e.preventDefault();
    if (k === KEY.BACK || k === KEY.RED) closeSettings();   // red toggles it shut (left now adjusts)
    else if (k === KEY.UP) settingsMove(-1);
    else if (k === KEY.DOWN) settingsMove(1);
    else if (k === KEY.OK) settingsOk();
    else if (k === KEY.RIGHT) settingsActivate(); // Right operates the row's primary toggle/cycle only
    else if (k === KEY.LEFT) settingsActivate(-1);
    return;
  }
  if (chpop.open) {
    e.preventDefault();
    // Colour keys and 0 close the list and then do their usual job below.
    if (k === KEY.RED || k === KEY.GREEN || k === KEY.YELLOW || k === KEY.BLUE || k === KEY.N0) closeChpop();
    else {
      if (isChUp(k) || k === KEY.UP) chpopMove(-1);
      else if (isChDown(k) || k === KEY.DOWN) chpopMove(1);
      else if (k === KEY.OK) chpopActivate();
      else if (k === KEY.BACK || k === KEY.LEFT || k === KEY.RIGHT) closeChpop();
      return;
    }
  }
  if (state.mode === 'add') {
    if (k === KEY.BACK) {
      e.preventDefault();
      // from the suggestions Back leaves; from search results it returns to the box
      if (add.zone === 'list' && !add.suggesting) backToInput(); else closeAdd();
    }
    else if (k === KEY.OK) { e.preventDefault(); confirmAdd(); }
    else if (add.zone === 'input' && k === KEY.DOWN && add.results.length) { e.preventDefault(); enterAddList(); }
    else if (add.zone === 'list' && k === KEY.UP) { e.preventDefault(); addNav(-1); }
    else if (add.zone === 'list' && k === KEY.DOWN) { e.preventDefault(); addNav(1); }
    return; // otherwise let the on-screen keyboard do the typing
  }
  if (state.mode === 'confirm') {
    e.preventDefault();
    if (k === KEY.OK) confirmYes();
    else if (k === KEY.BACK) confirmNo();
    return;
  }
  // watching a stream
  e.preventDefault();
  var video = document.getElementById('video');
  if (k === KEY.N0) { dimQuickKey(); return; }         // 0 toggles dim; press again within 3s to change strength
  if (k === KEY.BLUE) { openBrowse(); return; }        // blue opens the live browser
  if (k === KEY.RED) { openSettings(); return; }       // red opens settings
  if (k === KEY.GREEN) { if (!e.repeat) toggleChat(); return; }
  if (k === KEY.YELLOW) { openVodsForContext(); return; }
  if (!state.vod) {                                    // the surf list is for live channels
    if (isChUp(k)) { chpopMove(-1); return; }          // channel up/down surf the live list
    if (isChDown(k)) { chpopMove(1); return; }
  }
  // With the list open, OK belongs to the highlighted row, never to an alert.
  if (k === KEY.OK && state.notifyCurrent && !state.vod && !state.sidebarOpen) { activateNotify(); return; }
  // Rewind/fast-forward: a past video seeks; live rewinds along the stream's
  // timeline, and fast-forward heads back to the live edge.
  if (k === KEY.REW) { if (state.vod) seekVod(-60); else if (state.current) liveSeekBy(-60); return; }
  if (k === KEY.FF) {
    if (state.vod) seekVod(60);
    else if (state.current) { if (liveSeek.base !== null) liveSeekBy(60); else goLive(); }
    return;
  }
  // Transport keys mean the same thing whether or not the list is open.
  if (k === KEY.PAUSE) { try { video.pause(); } catch (e2) {} return; }
  if (k === KEY.PLAY) { playVideo(video); return; }
  if (k === KEY.STOP) { if (state.vod) exitVod(); else armOrExit(); return; }
  if (state.sidebarOpen) {
    resetIdle();
    // The bottom player tools are pointer-only: hovering highlights them, but
    // the D-pad always drives the channel list. Left/Right consistently tucks
    // the sidebar away, never cycles the tools.
    if (state.playerToolFocus >= 0) setPlayerToolFocus(-1);
    if (k === KEY.UP) moveSide(-1);
    else if (k === KEY.DOWN) moveSide(1);
    else if (k === KEY.OK) activateSide();               // OK (or a click) opens the highlighted channel
    else if (k === KEY.LEFT || k === KEY.RIGHT) closeSidebar();   // either side tucks the list away
    else if (k === KEY.BACK) {
      // Back is what put this list on screen, so Back again carries on up and out —
      // through the same "press again to exit" confirmation the exit uses everywhere
      // else, never straight out. Opened any other way (Left/Right, the pointer),
      // Back still just tucks the list away.
      if (state.backOpenedSidebar) armOrExit();
      else closeSidebarWithGrace();
    }
    return;
  }
  if (state.vod) {                                       // watching a past video
    if (k === KEY.BACK) {
      var dismissVodControls = vodBarVisible() || seekAccum.baseTime !== null;
      resetSeekAccum();
      vodButtonNav = false;
      if (dismissVodControls) {
        clearTimeout(overlayTimer);
        hideVodControls();
        state.suppressNudgeUntil = Date.now() + NUDGE_SUPPRESS_MS;
        hideCursor();
      } else {
        openSidebar();                                 // same ladder as live: the next Back arms the exit
        if (state.sidebarOpen) state.backOpenedSidebar = true;
      }
      return;
    }
    if (k === KEY.UP) {
      if (!vodButtonNav || vodFocus !== 'buttons') focusVodButtons();
      else showVodOverlay();
      vodButtonNav = true;
      return;
    }
    if (k === KEY.DOWN) { focusVodBar(); return; }
    if (vodButtonNav && vodFocus === 'buttons') {
      if (k === KEY.LEFT) { vodBtnMove(-1); return; }
      if (k === KEY.RIGHT) { vodBtnMove(1); return; }
      if (k === KEY.OK) { vodBtnActivate(); return; }
    }
    if (k === KEY.LEFT || k === KEY.RIGHT) { seekVodKey(k, e.repeat); return; }
    // OK lands on the play/pause button and takes the action in the same press —
    // one press pauses, the next resumes. The rest of the controls come up around
    // it, so the press after that can be a seek without hunting for the ladder.
    if (k === KEY.OK) { focusVodButtons(); toggleVodPlay(); return; }
    return;
  }
  // OK brought up the live timeline: Left/Right seek along it, Back puts it away.
  if (state.current && liveBar.focused && liveBarVisible()) {
    if (k === KEY.LEFT || k === KEY.RIGHT) { liveSeekKey(k, e.repeat); return; }
    if (k === KEY.BACK) {
      resetLiveSeek();
      document.getElementById('overlay').className = 'hidden';
      clearTimeout(overlayTimer);
      hideLiveBar();
      state.suppressNudgeUntil = Date.now() + NUDGE_SUPPRESS_MS;
      hideCursor();
      return;
    }
  }
  // While a live stream is playing, Back steps up to the channel list rather than
  // straight at the exit; the next Back leaves. On the idle screen there is nothing
  // to step up to, so Back still arms the exit there, and STOP always means stop.
  if (k === KEY.BACK && state.current) {
    openSidebar();
    if (state.sidebarOpen) state.backOpenedSidebar = true;
    return;
  }
  if (k === KEY.BACK) { armOrExit(); return; }
  if (k === KEY.LEFT || k === KEY.RIGHT) openSidebar();  // left or right brings the list up
  else if (k === KEY.UP) chpopMove(-1);                 // up/down surf the live channels
  else if (k === KEY.DOWN) chpopMove(1);
  else if (k === KEY.OK) { if (state.current) toggleOverlay(); else openSidebar(); }
});

document.addEventListener('keyup', function (e) {
  if (e.keyCode === vodSeekKey.key) vodSeekKey.key = 0;
  if (e.keyCode === liveSeek.key) liveSeek.key = 0;
});

/* Pointer, both mouse and the magic remote */
function favRowFromEvent(e) {
  var el = e.target;
  while (el && el !== document.body &&
         !(el.getAttribute && (el.getAttribute('data-slug') || el.getAttribute('data-type')))) {
    el = el.parentNode;
  }
  if (!el || el === document.body) return null;
  var list = document.getElementById('fav-list');
  for (var i = 0; i < list.children.length; i++) {
    if (list.children[i] === el) return { row: el, idx: i };
  }
  return null;
}
function browseCardFromEvent(e) {
  var el = e.target;
  while (el && el !== document.body && !(el.getAttribute && el.getAttribute('data-idx'))) el = el.parentNode;
  if (!el || el === document.body) return null;
  var i = parseInt(el.getAttribute('data-idx'), 10);
  if (isNaN(i) || i < 0 || i >= getBrowseGrid().items.length) return null;
  return { el: el, idx: i };
}
(function wirePointer() {
  var playerEl = document.getElementById('player');
  document.getElementById('notify').addEventListener('click', function (e) {
    e.stopPropagation();
    activateNotify();
  });
  playerEl.addEventListener('click', function (e) {
    if (!state.ready || state.mode !== 'player') return;
    if (e.target.id === 'video' || e.target === playerEl || e.target.id === 'idle') {
      if (state.sidebarOpen) {
        closeSidebarWithGrace();                                  // do not reopen on the next stray move
      } else {
        state.suppressNudgeUntil = 0;                               // an explicit click always brings it back
        openSidebar();
      }
    }
  });
  // Live keeps its full sidebar reveal. VOD reveals playback controls first;
  // reaching the left edge opens the sidebar as well.
  var lastX = -1, lastY = -1;
  playerEl.addEventListener('mousemove', function (e) {
    if (ChatWindow.activePointer(e.target)) return;
    if (diagDrag) return;                 // dragging the diagnostics window, not browsing
    if (liveBar.dragTarget !== null) return;   // dragging the live timeline
    if (!state.ready || state.mode !== 'player') return;
    if (lastX >= 0 && Math.abs(e.clientX - lastX) < 6 && Math.abs(e.clientY - lastY) < 6) return;
    lastX = e.clientX; lastY = e.clientY;
    showCursor();      // a real move brings the pointer back
    if (!state.sidebarOpen && Date.now() < state.suppressNudgeUntil) return;   // click-to-hide grace
    if (state.vod) {
      if (anyPanelOpen() || saver.on) return;
      if (vodDragging) return;
      var target = e.target;
      vodPointerHover = '';
      while (target && target !== playerEl) {
        if (target.id === 'vodbar' || VOD_BTN_IDS.indexOf(target.id) !== -1) {
          vodPointerHover = target.id;
          break;
        }
        target = target.parentNode;
      }
      if (state.sidebarOpen || e.clientX <= 48) nudgeSidebar();
      requestVodOverlay();
    } else if (liveBarVisible() && !state.sidebarOpen && e.clientX > 48) {
      // The timeline is up: pointing keeps it up rather than sliding it aside for
      // the channel list (which would pull it out from under the pointer). The
      // left edge still opens the list, as in a past video.
      armLiveOverlayHide();
    } else nudgeSidebar();
  });
  document.getElementById('side-refresh').addEventListener('click', function (e) {
    e.stopPropagation();
    if (state.mode === 'player') refreshSide();
  });
  var favList = document.getElementById('fav-list');
  favList.addEventListener('mouseover', function (e) {
    resetIdle();
    hideQualityHint();
    if (state.playerToolFocus >= 0) setPlayerToolFocus(-1);
    var hit = favRowFromEvent(e);
    if (hit && hit.idx !== state.sideFocus) {
      state.sideFocus = hit.idx;
      armSidePreview();      // pointing at a row earns it too
      applySideFocus();
    }
  });
  favList.addEventListener('click', function (e) {
    var hit = favRowFromEvent(e);
    if (!hit) return;
    state.sideFocus = hit.idx; applySideFocus();
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    var slug = hit.row.getAttribute('data-slug');
    if (act === 'pin' && slug) { togglePinFocused(); }
    else if (act === 'remove' && slug) { askRemove(slug); }
    else if (act === 'addfav') { addTempToFavorites(); }
    else { activateSide(); }
  });
  favList.addEventListener('wheel', function (e) {
    if (!state.sidebarOpen) return;
    e.preventDefault();
    favList.scrollTop += (e.deltaY > 0 ? 1 : -1) * 88;
  });
  favList.addEventListener('scroll', function () { if (state.sidebarOpen) scheduleSidePreview(); });
  document.getElementById('addok').addEventListener('click', function () {
    if (state.mode !== 'add') return;
    var q = document.getElementById('addinput').value.trim();
    if (q) addChannelBySlug(q);          // the Add button adds exactly what was typed
  });
  document.getElementById('addcancel').addEventListener('click', function () {
    if (state.mode === 'add') closeAdd();
  });
  document.getElementById('addmodal').addEventListener('click', function (e) {
    if (state.mode === 'add' && e.target === this) closeAdd();
  });
  document.getElementById('addinput').addEventListener('input', function () {
    if (state.mode === 'add') scheduleLiveSearch();
  });
  var aresults = document.getElementById('addresults');
  function aResultIdx(e) {
    var el = e.target;
    while (el && el !== aresults && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === aresults) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= add.results.length) ? -1 : i;
  }
  aresults.addEventListener('mouseover', function (e) {
    var i = aResultIdx(e);
    if (i >= 0 && i !== add.focus) { add.zone = 'list'; add.focus = i; applyAddFocus(); }
  });
  aresults.addEventListener('click', function (e) {
    var i = aResultIdx(e);
    if (i >= 0) { add.focus = i; selectAddResult(); }
  });
  document.getElementById('confirm-yes').addEventListener('click', function () {
    if (state.mode === 'confirm') confirmYes();
  });
  document.getElementById('confirm-no').addEventListener('click', function () {
    if (state.mode === 'confirm') confirmNo();
  });
  document.getElementById('confirmmodal').addEventListener('click', function (e) {
    if (state.mode === 'confirm' && e.target === this) confirmNo();
  });
  var addBtn = document.getElementById('side-add');
  if (addBtn) addBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (state.mode === 'player') openAdd();
  });
  // Browse popup pointer
  BROWSE_HEADERS.forEach(function (id, i) {
    var header = document.getElementById(id);
    if (header) header.addEventListener('mouseenter', function () { browse.zone = 'header'; browse.headerIdx = i; applyBrowseFocus(true); });
  });
  ['cats-search', 'cats-close'].forEach(function (id, i) { document.getElementById(id).addEventListener('mouseenter', function () { cats.zone = 'header'; cats.headerIdx = i; applyCatsFocus(true); }); });
  ['vods-filter', 'vods-close'].forEach(function (id, i) { document.getElementById(id).addEventListener('mouseenter', function () { vods.zone = 'header'; vods.headerIdx = i; applyVodFocus(true); }); });
  document.getElementById('browse-langbtn').addEventListener('click', function (e) {
    e.stopPropagation();
    browse.zone = 'lang';
    toggleBrowseLangMenu();
  });
  var langMenu = document.getElementById('browse-langmenu');
  langMenu.addEventListener('click', function (e) {
    e.stopPropagation();
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (el && el !== this) toggleBrowseLang(parseInt(el.getAttribute('data-idx'), 10));
  });
  langMenu.addEventListener('mouseover', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (el && el !== this) {
      var i = parseInt(el.getAttribute('data-idx'), 10);
      if (i !== browse.langIdx) { browse.langIdx = i; renderBrowseLangMenu(); }
    }
  });
  // Anywhere else in Browse dismisses the dropdown, the way a menu should.
  document.getElementById('browse').addEventListener('click', function () {
    if (browse.langMenuOpen) closeBrowseLangMenu();
  });
  var browseGrid = document.getElementById('browse-grid');
  browseGrid.addEventListener('mouseover', function (e) {
    var c = browseCardFromEvent(e);
    if (c) { browse.zone = 'grid'; browse.gridIdx = c.idx; applyBrowseFocus(); }
  });
  browseGrid.addEventListener('click', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-act') === 'badd') {
      e.stopPropagation();
      browseAddFavorite(e.target.getAttribute('data-slug'));
      return;
    }
    var c = browseCardFromEvent(e);
    if (c) { browse.zone = 'grid'; browse.gridIdx = c.idx; browseActivate(); }
  });
  browseGrid.addEventListener('wheel', function (e) {
    if (!browse.open) return;
    e.preventDefault();
    browseGrid.scrollTop += (e.deltaY > 0 ? 1 : -1) * 160;
    scheduleBrowseFill();
  });
  browseGrid.addEventListener('scroll', scheduleBrowseFill);
  document.getElementById('browse-close').addEventListener('click', function () { closeBrowse(); });
  var catsBtn = document.getElementById('browse-cats-btn');
  if (catsBtn) catsBtn.addEventListener('click', function (e) { e.stopPropagation(); openCats(); });
  document.getElementById('browse-discover').addEventListener('click', function (e) { e.stopPropagation(); toggleBrowseDiscover(); });
  document.getElementById('browse-hideblocked').addEventListener('click', function (e) { e.stopPropagation(); toggleBrowseHideBlocked(); });
  document.getElementById('vods-filter').addEventListener('click', function (e) { e.stopPropagation(); toggleVodHideWatched(); });
  // The x on the diagnostics panel switches the overlay off.
  document.getElementById('diag-close').addEventListener('click', function (e) {
    e.stopPropagation();
    settings.diagnostics = false;
    saveSettings();
    syncDiagnostics();
    if (settings.open) renderSettings();
    toast('Diagnostics off');
  });
  // The whole diagnostics panel is a drag handle: grab anywhere, park anywhere.
  document.getElementById('diagnostics').addEventListener('mousedown', function (e) {
    if (e.target.id === 'diag-close') return;
    var r = this.getBoundingClientRect();
    diagDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    diagManualPos = true;
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!diagDrag) return;
    var el = document.getElementById('diagnostics');
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(0, Math.min(1920 - w, e.clientX - diagDrag.dx));
    var top = Math.max(0, Math.min(1080 - h, e.clientY - diagDrag.dy));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', function () { diagDrag = null; });
  // Pinned category chips above the grid.
  document.getElementById('browse-pinnedcats').addEventListener('click', function (e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-x')) {   // the ✕ unpins instead of selecting
      e.stopPropagation();
      var pchip = t.parentNode;
      toggleCatPin(pchip.getAttribute('data-cslug'), pchip.getAttribute('data-cname'));
      return;
    }
    var el = t;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-cslug') != null)) el = el.parentNode;
    if (!el || el === this) return;
    e.stopPropagation();
    var cslug = el.getAttribute('data-cslug');
    browse.zone = 'pins'; browse.pinIdx = Array.prototype.indexOf.call(this.children, el);
    if (cslug) toggleBrowseCat(cslug, el.getAttribute('data-cname') || '');
    else clearBrowseCats();
  });
  // Categories popup pointer
  var catsGrid = document.getElementById('cats-grid');
  function catCardIdx(e) {
    var el = e.target;
    while (el && el !== catsGrid && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === catsGrid) return -2;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) || i < 0 || i >= getCatsGrid().items.length ? -2 : i;
  }
  catsGrid.addEventListener('mouseover', function (e) {
    var i = catCardIdx(e);
    if (i >= 0 && (i !== cats.gridIdx || cats.zone !== 'grid')) { cats.zone = 'grid'; cats.gridIdx = i; applyCatsFocus(); }
  });
  catsGrid.addEventListener('click', function (e) {
    var be = e.target;    // the block badge blocks instead of selecting
    while (be && be !== catsGrid && !(be.getAttribute && be.getAttribute('data-act') === 'catblock')) be = be.parentNode;
    if (be && be !== catsGrid) {
      e.stopPropagation();
      var bidx = catCardIdx(e);
      if (bidx > 0 && displayedCats()[bidx - 1]) {
        var bcat2 = displayedCats()[bidx - 1];
        var nb = toggleCatBlock(bcat2.slug, bcat2.name || bcat2.slug);
        toast((nb ? 'Blocked ' : 'Unblocked ') + (bcat2.name || bcat2.slug));
        applyBlockedChange();
      }
      return;
    }
    var pe = e.target;    // the pin badge toggles instead of selecting
    while (pe && pe !== catsGrid && !(pe.getAttribute && pe.getAttribute('data-act') === 'catpin')) pe = pe.parentNode;
    if (pe && pe !== catsGrid) {
      e.stopPropagation();
      var pidx = catCardIdx(e);
      if (pidx > 0 && displayedCats()[pidx - 1]) {
        var pcat = displayedCats()[pidx - 1];
        toggleCatPin(pcat.slug, pcat.name || pcat.slug);
      }
      return;
    }
    var i = catCardIdx(e);
    if (i >= 0) { cats.zone = 'grid'; cats.gridIdx = i; catsActivate(); }
  });
  catsGrid.addEventListener('wheel', function (e) {
    if (!cats.open) return;
    e.preventDefault();
    catsGrid.scrollTop += (e.deltaY > 0 ? 1 : -1) * 160;
    if (!cats.error && catsGrid.scrollTop + catsGrid.clientHeight >= catsGrid.scrollHeight - 400) loadCatsMore(false);
  });
  document.getElementById('cats-close').addEventListener('click', function () { closeCats(); });
  document.getElementById('cats-search').addEventListener('input', function () {
    if (!cats.open) return;
    var q = this.value.trim();
    cats.query = q; cats.searchError = false; cats.searching = !!q; cats.focusKey = null;
    clearTimeout(catsSearchTimer);
    if (!q) {                                  // cleared: back to the paginated list
      cats.results = null; cats.searching = false;
      cats.gridIdx = 0;
      renderCats();
      if (!cats.list.length && cats.hasMore && !cats.error) loadCatsMore(true);
      return;
    }
    cats.results = []; cats.gridIdx = 0; renderCats();
    catsSearchTimer = setTimeout(function () { runCatsSearch(q); }, 250);
  });
  // Past videos popup pointer
  var vodsGrid = document.getElementById('vods-grid');
  function vodCardIdx(e) {
    var el = e.target;
    while (el && el !== vodsGrid && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === vodsGrid) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= getVodGrid().items.length) ? -1 : i;
  }
  vodsGrid.addEventListener('mouseover', function (e) {
    var i = vodCardIdx(e);
    if (i >= 0 && (i !== vods.gridIdx || vods.zone !== 'grid')) { vods.zone = 'grid'; vods.gridIdx = i; applyVodFocus(); }
  });
  vodsGrid.addEventListener('click', function (e) {
    var i = vodCardIdx(e);
    if (i >= 0) { vods.zone = 'grid'; vods.gridIdx = i; vodActivate(); }
  });
  vodsGrid.addEventListener('wheel', function (e) {
    if (!vods.open) return;
    e.preventDefault();
    vodsGrid.scrollTop += (e.deltaY > 0 ? 1 : -1) * 160;
  });
  document.getElementById('vods-close').addEventListener('click', function () { closeVods(); });
  // Drag (or click) the VOD seek track to scrub. While dragging we preview the
  // position on the bar and only seek the video on release, so it stays smooth.
  var vodTrack = document.getElementById('vodbar-track');
  var vodTrackRect = null, scrubFrame = null, scrubX = 0;
  function vodTrackFrac(e) {
    var r = vodTrackRect || vodTrack.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  }
  function vodPreview(e) {
    var v = document.getElementById('video');
    if (isFinite(v.duration) && v.duration) drawVodBar(vodTrackFrac(e) * v.duration, v.duration);
  }
  document.getElementById('vodbar').addEventListener('mousedown', function (e) {
    if (!state.vod) return;
    for (var t = e.target; t; t = t.parentNode) if (t.id === 'vodgolive') return;   // Go live is a button
    // The handle overhangs the track's ends, so accept a grab just beyond them.
    vodTrackRect = vodTrack.getBoundingClientRect();
    if (e.clientX < vodTrackRect.left - 30 || e.clientX > vodTrackRect.right + 30) { vodTrackRect = null; return; }
    vodDragging = true;
    clearTimeout(overlayTimer);                 // keep the bar visible while dragging
    clearTimeout(state.idleTimer);
    document.getElementById('vodbar').className = '';
    vodPreview(e);
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (vodDragging) {
      scrubX = e.clientX;
      if (scrubFrame === null) scrubFrame = requestAnimationFrame(function () {
        scrubFrame = null;
        if (vodDragging) vodPreview({ clientX: scrubX });
      });
    }
  });
  document.addEventListener('mouseup', function (e) {
    if (vodDragging) {
      vodDragging = false;
      seekVodFrac(vodTrackFrac(e));
      vodTrackRect = null;
      if (scrubFrame !== null) { cancelAnimationFrame(scrubFrame); scrubFrame = null; }
      if (state.sidebarOpen) resetIdle();
    }
  });
  // Dedicated player tools: stream quality and Settings stay separate.
  var settingsButton = document.getElementById('settings-button');
  if (settingsButton) {
    settingsButton.addEventListener('mouseenter', function () {
      hideQualityHint();
      if (state.playerToolFocus !== 1) setPlayerToolFocus(1);
      resetIdle();
    });
    settingsButton.addEventListener('click', function (e) {
      e.stopPropagation(); setPlayerToolFocus(1); openSettings();
    });
  }
  var wtwButton = document.getElementById('wtw-button');
  wtwButton.addEventListener('mouseenter', function () {
    hideQualityHint();
    if (state.playerToolFocus !== 2) setPlayerToolFocus(2);
    resetIdle();
  });
  wtwButton.addEventListener('click', function (e) {
    e.stopPropagation(); setPlayerToolFocus(2); openWhatToWatch();
  });
  var wtwList = document.getElementById('wtw-list');
  function wtwIdx(e) {
    var el = e.target;
    while (el && el !== wtwList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === wtwList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= wtw.items.length) ? -1 : i;
  }
  wtwList.addEventListener('mouseover', function (e) {
    var i = wtwIdx(e);
    if (i >= 0 && i !== wtw.focus) wtwMove(i - wtw.focus);
  });
  wtwList.addEventListener('click', function (e) {
    var i = wtwIdx(e);
    if (i >= 0) { wtw.focus = i; wtwActivate(); }
  });
  wtwList.addEventListener('wheel', function (e) { e.preventDefault(); wtwList.scrollTop += (e.deltaY > 0 ? 1 : -1) * 100; });
  document.getElementById('wtwmodal').addEventListener('click', function (e) {
    if (e.target === this) closeWhatToWatch();
  });
  var qualityButton = document.getElementById('quality-button');
  if (qualityButton) {
    qualityButton.addEventListener('mouseenter', function () {
      if (state.playerToolFocus !== 0) setPlayerToolFocus(0);
      resetIdle();
      showQualityHint();
    });
    qualityButton.addEventListener('mouseleave', function () { hideQualityHint(); });
    qualityButton.addEventListener('click', function (e) {
      e.stopPropagation(); setPlayerToolFocus(0); openQualityOpt();
    });
  }
  var slist = document.getElementById('settings-list');
  function sRowIdx(e) {
    var el = e.target;
    while (el && el !== slist && !(el.getAttribute && el.getAttribute('data-focusable'))) el = el.parentNode;
    if (!el || el === slist) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) ? -1 : i;
  }
  bindSettingsListPointer(slist, function (e) {
    var i = sRowIdx(e);
    if (i >= 0 && i !== settings.focus) { settings.focus = i; applySettingsFocus(); }
  });
  slist.addEventListener('click', function (e) {
    if (e.target.tagName === 'INPUT') return;
    var i = sRowIdx(e);
    if (i < 0) return;
    settings.focus = i; applySettingsFocus();
    var node = e.target, onSwitch = false;
    while (node && node !== this) {
      if (node.getAttribute && node.getAttribute('data-setting-switch')) { onSwitch = true; break; }
      node = node.parentNode;
    }
    if (onSwitch) settingsActivate();
    else settingsOk();
  });
  document.getElementById('settingsmodal').addEventListener('click', function (e) {
    if (e.target === this) closeSettings();
  });
  // The version chip opens the release notes when an update is available
  document.getElementById('settings-ver').addEventListener('click', function (e) {
    e.stopPropagation();
    if (updateInfo) openUpdateNotes();
  });
  // The bottom colour-button legend is clickable too.
  document.getElementById('cbguide').addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-act'))) el = el.parentNode;
    if (!el || el === this) return;
    var act = el.getAttribute('data-act');
    if (act === 'settings') openSettings();
    else if (act === 'refresh') refreshSide();
    else if (act === 'chat') toggleChat();
    else if (act === 'vods') openVodsForContext();
    else if (act === 'browse') openBrowse();
    else if (act === 'dim') dimQuickKey();
  });
  // Pointing at the category chip offers to block it (see showCatPop).
  document.getElementById('ov-title').addEventListener('mouseover', function (e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute('data-catslug') && state.mode === 'player' && !state.vod) showCatPop(el);
  });
  document.getElementById('ov-title').addEventListener('mouseout', function (e) {
    var to = e.relatedTarget;
    if (!(to && to.getAttribute && to.getAttribute('data-catslug'))) leaveCatPop();
  });
  var ovcatPop = document.getElementById('ovcat-pop');
  ovcatPop.addEventListener('mouseenter', function () { clearTimeout(catPop.timer); catPop.hover = true; });
  ovcatPop.addEventListener('mouseleave', leaveCatPop);
  ovcatPop.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!catPop.slug) return;
    var nowBlocked = toggleCatBlock(catPop.slug, catPop.name || catPop.slug);
    toast((nowBlocked ? 'Blocked ' : 'Unblocked ') + (catPop.name || catPop.slug));
    hideCatPop();
    applyBlockedChange();
    armLiveOverlayHide();
  });
  // The category chip in the top bar opens Browse filtered to that category.
  document.getElementById('ov-title').addEventListener('click', function (e) {
    var el = e.target;
    if (!(el.getAttribute && el.getAttribute('data-catslug'))) return;
    e.stopPropagation();
    if (!state.ready || state.mode !== 'player') return;
    openBrowse(el.getAttribute('data-catslug'), el.textContent);
  });
  // Mini home screen: Continue Watching card + live-favorite tiles.
  document.getElementById('home-resume-row').addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-vid'))) el = el.parentNode;
    if (!el || el === this) return;
    e.stopPropagation();
    closeSidebar();
    openSavedVod(el.getAttribute('data-slug'), el.getAttribute('data-vid'));
  });
  document.getElementById('home-live-row').addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== this && !(el.getAttribute && el.getAttribute('data-slug'))) el = el.parentNode;
    if (!el || el === this) return;
    e.stopPropagation();
    var slug = el.getAttribute('data-slug');
    if (state.channels[slug] && state.channels[slug].live) { closeSidebar(); play(slug); }
  });
  // VOD play/pause button and the -30/+30 skip buttons beside it
  // Hovering moves focus, the same way the sidebar and the grids behave, so the
  // pointer and the D-pad share one highlight rather than having two of their own.
  function hoverVodControl(id) {
    if (!state.vod) return;
    vodPointerHover = id;
    if (state.sidebarOpen) resetIdle();
  }
  function leaveVodControl() {
    if (!state.vod || vodPointerHover !== this.id) return;
    vodPointerHover = '';
    if (vodBarVisible()) armVodOverlayHide();
    if (state.sidebarOpen) resetIdle();
  }
  document.getElementById('vodbar').addEventListener('mouseenter', function () {
    hoverVodControl(this.id);
    focusVodBar();
  });
  document.getElementById('vodbar').addEventListener('mouseleave', leaveVodControl);
  for (var vb = 0; vb < VOD_BTN_IDS.length; vb++) {
    (function (i) {
      document.getElementById(VOD_BTN_IDS[i])
        .addEventListener('mouseenter', function () { hoverVodControl(this.id); focusVodButtons(i); });
      document.getElementById(VOD_BTN_IDS[i]).addEventListener('mouseleave', leaveVodControl);
    })(vb);
  }
  document.getElementById('vodplay').addEventListener('click', function (e) { e.stopPropagation(); toggleVodPlay(); });
  document.getElementById('vodback').addEventListener('click', function (e) { e.stopPropagation(); if (state.vod) seekVod(-30); });
  document.getElementById('vodfwd').addEventListener('click', function (e) { e.stopPropagation(); if (state.vod) seekVod(30); });
  document.getElementById('vodgolive').addEventListener('click', function (e) { e.stopPropagation(); goLive(); });
  // Live timeline: click to jump there, the chip to go live. Hovering holds it open.
  // Press anywhere on the track (the handle included) and drag: the bar previews
  // where you are pointing and the seek happens once, on release.
  var liveTrack = document.getElementById('livebar-track');
  var liveTrackRect = null, liveDragFrame = null, liveDragX = 0;
  function liveTrackTarget(clientX) {
    var p = livePositions();
    var r = liveTrackRect || liveTrack.getBoundingClientRect();
    if (!p || !(r.width > 0)) return null;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * p.edge;
  }
  // The handle is drawn past the ends of the track (at the live edge it sits
  // right beside the Go live slot), so the grab area is the whole bar, measured
  // against the track. Only Go live keeps its own press.
  function inside(el, id) { for (; el; el = el.parentNode) if (el.id === id) return true; return false; }
  document.getElementById('livebar').addEventListener('mousedown', function (e) {
    if (!state.current || state.vod || inside(e.target, 'livebar-live')) return;
    var tr = liveTrack.getBoundingClientRect();
    if (e.clientX < tr.left - 30 || e.clientX > tr.right + 30) return;   // the time label is not a grab
    e.preventDefault(); e.stopPropagation();
    resetLiveSeek();
    liveTrackRect = tr;
    liveBar.dragTarget = liveTrackTarget(e.clientX);
    clearTimeout(overlayTimer);
    clearTimeout(state.idleTimer);            // the list must not close mid-drag
    showLiveBar(true);
  });
  document.addEventListener('mousemove', function (e) {
    if (liveBar.dragTarget === null) return;
    liveDragX = e.clientX;
    if (liveDragFrame === null) liveDragFrame = requestAnimationFrame(function () {
      liveDragFrame = null;
      if (liveBar.dragTarget === null) return;
      var t = liveTrackTarget(liveDragX);
      if (t !== null) { liveBar.dragTarget = t; drawLiveBar(); }
    });
  });
  document.addEventListener('mouseup', function (e) {
    if (liveBar.dragTarget === null) return;
    var t = liveTrackTarget(e.clientX);
    if (t === null) t = liveBar.dragTarget;
    liveBar.dragTarget = null;
    liveTrackRect = null;
    if (liveDragFrame !== null) { cancelAnimationFrame(liveDragFrame); liveDragFrame = null; }
    seekLiveTo(t);
    if (state.sidebarOpen) resetIdle();
    else { var c = state.current && state.channels[state.current]; if (c) showOverlay(c); }
  });
  liveTrack.addEventListener('click', function (e) { e.stopPropagation(); });
  document.getElementById('livebar-live').addEventListener('click', function (e) { e.stopPropagation(); goLive(); });
  document.getElementById('livebar').addEventListener('click', function (e) { e.stopPropagation(); });
  document.getElementById('livebar').addEventListener('mouseenter', function () {
    liveBar.hover = true;
    clearTimeout(overlayTimer);
    if (state.sidebarOpen) clearTimeout(state.idleTimer);
    showLiveBar(true);
  });
  document.getElementById('livebar').addEventListener('mouseleave', function () {
    liveBar.hover = false;
    if (state.sidebarOpen) { resetIdle(); return; }
    armLiveOverlayHide();
  });
  // Dim options popup pointer
  var dimoptList = document.getElementById('dimopt-list');
  function dimoptIdx(e) {
    var el = e.target;
    while (el && el !== dimoptList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === dimoptList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) ? -1 : i;
  }
  bindSettingsListPointer(dimoptList, function (e) { var i = dimoptIdx(e); if (i >= 0 && i !== dimopt.focus) dimoptMove(i - dimopt.focus); });
  dimoptList.addEventListener('click', function (e) { var i = dimoptIdx(e); if (i >= 0) { dimopt.focus = i; dimoptActivate(); } });
  document.getElementById('dimoptmodal').addEventListener('click', function (e) { if (e.target === this) closeDimOpt(); });
  // Chat options popup pointer
  var chatoptList = document.getElementById('chatopt-list');
  function chatoptIdx(e) {
    var el = e.target;
    while (el && el !== chatoptList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === chatoptList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return isNaN(i) ? -1 : i;
  }
  bindSettingsListPointer(chatoptList, function (e) { var i = chatoptIdx(e); if (i >= 0 && i !== chatopt.focus) { chatopt.focus = i; applyChatOptFocus(); } });
  chatoptList.addEventListener('click', function (e) {
    if (e.target.tagName === 'INPUT') return;
    var i = chatoptIdx(e); if (i < 0) return;
    chatopt.focus = i;
    chatoptActivate();
  });
  document.getElementById('chatopt-close').addEventListener('click', closeChatOpt);
  document.getElementById('chatoptmodal').addEventListener('click', function (e) { if (e.target === this) closeChatOpt(); });
  // Blocked categories popup pointer
  document.getElementById('backup-choices').addEventListener('click', function (e) {
    var i = parseInt(e.target.getAttribute && e.target.getAttribute('data-idx'), 10);
    if (!isNaN(i) && backup.inbox && !backup.busy) { backup.choice = i; backupChoose(); }
  });
  document.getElementById('backupmodal').addEventListener('click', function (e) {
    if (e.target === this && !backup.inbox) closeBackup();
  });
  var blockedcatsList = document.getElementById('blockedcats-list');
  function blockedcatsIdx(e) {
    var el = e.target;
    while (el && el !== blockedcatsList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === blockedcatsList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    // the link row sits one past the last entry, so it is a valid index here
    return (isNaN(i) || i < 0 || i > blockedcatsLinkIndex()) ? -1 : i;
  }
  bindSettingsListPointer(blockedcatsList, function (e) {
    var i = blockedcatsIdx(e);
    if (i >= 0 && i !== blockedcats.focus) { blockedcats.focus = i; renderBlockedCats(); }
  });
  blockedcatsList.addEventListener('click', function (e) {
    var i = blockedcatsIdx(e);
    if (i >= 0) { blockedcats.focus = i; blockedcatsActivate(); }
  });
  document.getElementById('blockedcatsmodal').addEventListener('click', function (e) {
    if (e.target === this) closeBlockedCats();
  });
  // Stream quality picker pointer
  var qualityoptList = document.getElementById('qualityopt-list');
  function qualityoptIdx(e) {
    var el = e.target;
    while (el && el !== qualityoptList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === qualityoptList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= qualityopt.items.length) ? -1 : i;
  }
  bindSettingsListPointer(qualityoptList, function (e) {
    var i = qualityoptIdx(e);
    if (i >= 0 && i !== qualityopt.focus) qualityoptMove(i - qualityopt.focus);
  });
  qualityoptList.addEventListener('click', function (e) {
    var i = qualityoptIdx(e);
    if (i >= 0) { qualityopt.focus = i; qualityoptActivate(); }
  });
  var qualityAlertSwitch = document.getElementById('qualityopt-alert');
  qualityAlertSwitch.addEventListener('mouseover', function () {
    if (qualityopt.open && qualityopt.focus !== -1) qualityoptMove(-1 - qualityopt.focus);
  });
  qualityAlertSwitch.addEventListener('click', function (e) {
    e.stopPropagation();
    if (qualityopt.open) toggleQualityAlert();
  });
  document.getElementById('qualityoptmodal').addEventListener('click', function (e) {
    if (e.target === this) closeQualityOpt();
  });
  // Update-available release notes popup
  document.getElementById('update-close').addEventListener('click', function () { closeUpdateNotes(); });
  document.getElementById('updatemodal').addEventListener('click', function (e) { if (e.target === this) closeUpdateNotes(); });
  // Live-channels surf popup pointer
  var chpopList = document.getElementById('chpop-list');
  function chRowIdx(e) {
    var el = e.target;
    while (el && el !== chpopList && !(el.getAttribute && el.getAttribute('data-idx') != null)) el = el.parentNode;
    if (!el || el === chpopList) return -1;
    var i = parseInt(el.getAttribute('data-idx'), 10);
    return (isNaN(i) || i < 0 || i >= chpop.list.length) ? -1 : i;
  }
  chpopList.addEventListener('mouseover', function (e) {
    var i = chRowIdx(e);
    if (i >= 0 && i !== chpop.idx) { chpop.idx = i; applyChpopFocus(); resetChpopTimer(); }
  });
  chpopList.addEventListener('click', function (e) {
    var i = chRowIdx(e);
    if (i >= 0) { chpop.idx = i; chpopActivate(); }
  });
  // Clicking the dimmed area outside the panel closes the surf popup, so a click
  // never falls through to the sidebar and leaves the popup stuck open.
  document.getElementById('chpop').addEventListener('click', function (e) {
    if (e.target === this) closeChpop();
  });
  // A pointer move anywhere counts as activity for the burn-in guard.
  document.addEventListener('mousemove', function () { markInput(); });
  document.addEventListener('mousedown', function () { markInput(); });
  document.addEventListener('wheel', function () { markInput(); });
})();

/* Watching the video element for trouble */
(function wireVideo() {
  var video = document.getElementById('video');
  video.addEventListener('error', function () {
    if (state.vod) { reloadVod(); return; }
    if (PB.active && state.current) recoverPlayback(state.current);
  });
  video.addEventListener('ended', function () {
    // A queued ended task from a source we just replaced must not complete or
    // skip the new VOD (or be mistaken for the newly resumed live channel).
    if (!video.ended) return;
    if (state.vod && state.vod.liveRewind) { liveRewindEnded(); return; }
    if (state.vod) {
      if (state.vod.completed || state.vod.ending) return;
      state.vod.ending = true;
      completeVodProgress();
      advanceVodOrExit();
      return;
    }
    if (PB.active && state.current) handleEnded(state.current);   // detect a finished live stream
  });
  video.addEventListener('playing', function () {
    PB.stallCount = 0; PB.netRetries = 0; PB.mediaRetries = 0; setBanner('');
    setPosterStill(null);                           // real frames are on the plane now
    hideSpinner();
  });
  // loadeddata means a first frame exists, which is usually a touch earlier
  // than 'playing' — drop the still at whichever arrives first.
  video.addEventListener('loadeddata', function () { setPosterStill(null); });
  // Buffering spinner for both live and VOD.
  video.addEventListener('waiting', function () { resetVodRecovery(); if (!video.paused) showSpinnerSoon(); });
  video.addEventListener('seeking', function () { resetVodRecovery(); showSpinnerSoon(); });
  video.addEventListener('loadedmetadata', function () { if (state.vod) applyVodResume(); });
  video.addEventListener('durationchange', function () { if (state.vod) applyVodResume(); });
  video.addEventListener('canplay', function () { if (state.vod) applyVodResume(); hideSpinner(); });
  video.addEventListener('timeupdate', function () {
    if (state.vod) { trackVodRecovery(); saveVodProgress(false); }
    else { tickLiveWatch(); saveLiveMark(false); }
  });
  video.addEventListener('seeked', function () {
    hideSpinner();
    if (state.vod) saveVodProgress(true);
  });
  // Keep the VOD play/pause icon in sync with the actual state.
  video.addEventListener('play', function () { if (state.vod) vodPlayIcon(); });
  video.addEventListener('pause', function () {
    if (state.vod) { resetVodRecovery(); saveVodProgress(true); vodPlayIcon(); hideSpinner(); }
  });
})();

// While we are idle and cannot reach Kick, retry a little quicker than the
// normal thirty second poll. It stops on its own and never piles up.
function scheduleDownRetry() {
  if (state.downRetry) return;
  state.downRetry = true;
  (function loop() {
    setTimeout(function () {
      if (state.current || !state.netDown) { state.downRetry = false; return; }
      fetchFavorites(function () {
        if (state.sidebarOpen) renderSidebar();
        if (!state.current && !state.vod) {
          if (state.netDown) showNothing();
          else retryLastVodAfterReconnect();
        }
        if (state.netDown && !state.current) loop(); else state.downRetry = false;
      });
    }, 8000);
  })();
}

