/* Local boot-stripped fixture tests. No external images or device endpoints. */
(function (root) {
  'use strict';
  // Invoked only by the local screenshot harness, after behavioral checks.
  root.setupVisualScreenshot = function (mode) {
    function el(id) { return document.getElementById(id); }
    UIPolish.cancelDetails();
    if (typeof settingDescTimer !== 'undefined') clearTimeout(settingDescTimer);
    if (typeof settingsIdleTimer !== 'undefined') clearTimeout(settingsIdleTimer);
    ['settingsmodal', 'qualityoptmodal', 'dimoptmodal', 'chatoptmodal', 'blockedcatsmodal', 'browse', 'cats', 'vods',
      'settings-desc', 'quality-hint', 'browse-tip', 'overlay', 'vodbar', 'vodplay', 'vodback', 'vodfwd', 'seekpop', 'cbguide',
      'player-tools', 'notify', 'toast', 'idle', 'spinner', 'chat'].forEach(function (id) { if (el(id)) el(id).classList.add('hidden'); });
    settings.open = false; chatopt.open = false; dimopt.open = false; qualityopt.open = false;
    browse.open = false; cats.open = false; vods.open = false;
    state.sidebarOpen = false; el('sidebar').classList.remove('open');
    state.current = 'alpha'; state.vod = null; state.ready = true;
    settings.uiText = mode.indexOf('large') !== -1 ? 'large' : 'normal';
    settings.dim = false;
    UIPolish.apply(true);
    if (mode.indexOf('settings') === 0) {
      openSettings();
      if (mode.indexOf('controls') !== -1) { settings.focus = settings.items.length - 1; applySettingsFocus(); }
    } else if (mode === 'dim-large') {
      openDimOpt();
    } else if (mode === 'chat-large') {
      openChatOpt();
      UIPolish.chatIdentity('Alpha | Evening conversations', '');
    } else if (mode.indexOf('vods') === 0) {
      vods.open = true; vods.slug = 'alpha'; vods.name = 'Alpha'; vods.gridIdx = 0; vods.nav = 'grid';
      vods.list = []; vods.listAll = []; vods.hideWatched = false;
      el('vods').classList.remove('hidden'); el('vods-title').textContent = 'Past videos — Alpha';
      if (mode !== 'vods-empty') {
        for (var i = 0; i < 16; i++) vods.list.push({
          id: 300 + i, session_title: i === 0 ? 'A long evening stream: conversations, unexpected discoveries, and a complete title that remains readable without moving text' : ['A relaxed evening with chat', 'Finding the next great game', 'Weekend conversations'][i % 3],
          source: 'http://127.0.0.1/fixture-only-video.m3u8', duration: 7200000, views: 3200 + i * 120,
          created_at: '2026-09-10T18:00:00Z', categories: [{ name: 'Just Chatting' }]
        });
      }
      vods.listAll = vods.list.slice(); renderVods(); renderVodFilterChip();
    }
    return new Promise(function (resolve) { setTimeout(resolve, mode === 'vods-long' ? 750 : 160); });
  };
  root.runVisualTests = function (assert) {
    var doc = root.document;
    var saved = [], preference = root.settings || (root.settings = {});
    var oldText = preference.uiText;
    var oldDim = preference.dim, oldScope = preference.dimScope, oldStrength = preference.dimStrength;
    var bodyClass = doc.body.className;
    var fixture = doc.createElement('div');
    fixture.id = 'visual-fixture'; doc.body.appendChild(fixture);
    function el(id) { return doc.getElementById(id); }
    function remember(node, contents) {
      if (!node) return;
      saved.push({ node: node, style: node.getAttribute('style'), cls: node.className, html: contents ? node.innerHTML : null });
    }
    function wait(ms) { return new Promise(function (resolve) { root.setTimeout(resolve, ms); }); }
    function rect(node) { return node.getBoundingClientRect(); }
    function intersects(a, b) { return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; }
    function restore() {
      UIPolish.cancelDetails();
      preference.uiText = oldText;
      preference.dim = oldDim; preference.dimScope = oldScope; preference.dimStrength = oldStrength;
      UIPolish.apply(true);
      for (var i = saved.length - 1; i >= 0; i--) {
        var item = saved[i];
        if (item.style === null) item.node.removeAttribute('style'); else item.node.setAttribute('style', item.style);
        item.node.className = item.cls;
        if (item.html !== null) item.node.innerHTML = item.html;
      }
      doc.body.className = bodyClass;
      if (fixture.parentNode) fixture.parentNode.removeChild(fixture);
    }
    function rows(list, n, quality) {
      list.innerHTML = '';
      for (var i = 0; i < n; i++) {
        var row = doc.createElement('div');
        row.className = quality ? 'qpick' : 'srow';
        var label = doc.createElement('span'); label.className = quality ? 'qpick-label' : 'slabel';
        label.textContent = i === 0 ? 'Background transparency' : 'Setting ' + (i + 1);
        var pill = doc.createElement('span'); pill.className = quality ? 'qpick-check' : 'spill'; pill.textContent = quality ? '✓' : 'Off';
        row.appendChild(label); row.appendChild(pill); list.appendChild(row);
      }
    }
    function card(title) {
      var node = doc.createElement('div'); node.className = 'bcard';
      node.innerHTML = '<div class="bthumb"></div><div class="bmeta"><div class="bname"></div><div class="btitle">Just Chatting</div><div class="bsub">Yesterday</div></div>';
      node.querySelector('.bname').textContent = title; return node;
    }
    var modalIds = ['settingsmodal', 'qualityoptmodal', 'dimoptmodal', 'chatoptmodal', 'blockedcatsmodal', 'browse', 'cats', 'vods', 'updatemodal'];
    var panelIds = ['settingsbox', 'qualityoptbox', 'dimoptbox', 'chatoptbox', 'blockedcatsbox'];
    var listIds = ['settings-list', 'qualityopt-list', 'dimopt-list', 'chatopt-list', 'blockedcats-list'];
    var obstacleIds = ['chat', 'sidebar', 'player-tools', 'cbguide', 'overlay', 'vodbar', 'notify', 'settings-desc', 'quality-hint'];
    var longTitle = 'A long evening stream: conversations, unexpected discoveries, and a complete title that remains readable without moving text';
    var shortCard, longCard, panel, anchor, descriptionBefore;
    return Promise.resolve().then(function () {
      assert(!!root.UIPolish, 'UI polish API is present');
      modalIds.concat(obstacleIds).forEach(function (id) { var node = el(id); if (node) { remember(node); node.classList.add('hidden'); } });
      panelIds.forEach(function (id) { remember(el(id)); });
      listIds.forEach(function (id) { remember(el(id), true); });
      remember(el('chatopt-head'), true); remember(el('chatopt-note'), true);
      remember(el('vods-grid'), true);
      preference.uiText = 'normal'; UIPolish.init(); UIPolish.apply(true);
      var video = el('video'), videoRect = rect(video);
      preference.uiText = 'large'; UIPolish.apply();
      assert(doc.body.classList.contains('ui-text-large'), 'large text option applies to UI');
      assert(rect(video).width === videoRect.width && rect(video).height === videoRect.height, 'large text never scales the video plane');
      assert(UIPolish.apply() === false, 'unchanged preferences skip geometry work');
      preference.uiText = 'normal'; UIPolish.apply();
      el('vods').classList.remove('hidden');
      var grid = el('vods-grid'); grid.innerHTML = '';
      shortCard = card('Short title'); longCard = card(longTitle);
      grid.appendChild(shortCard); grid.appendChild(longCard);
      assert(shortCard.offsetHeight === 366 && longCard.offsetHeight === 366, 'short and long VOD cards have a fixed 366px height');
      assert(longCard.querySelector('.bname').offsetHeight === 60, 'normal VOD title reserves exactly two 30px lines');
      assert(root.getComputedStyle(longCard.querySelector('.bname')).webkitLineClamp === '2', 'VOD titles clamp at two lines');
      longCard.classList.add('focused');
      assert(root.getComputedStyle(longCard).boxShadow === 'none', 'focused cards have a crisp edge without glow');
      preference.uiText = 'large'; UIPolish.apply();
      assert(shortCard.offsetHeight === 394 && longCard.offsetHeight === 394, 'large text keeps both VOD cards at 394px');
      assert(longCard.querySelector('.bname').offsetHeight === 68, 'large VOD title reserves exactly two 34px lines');
      el('vods').classList.add('hidden');
      rows(el('settings-list'), 24, false); rows(el('chatopt-list'), 24, false); rows(el('qualityopt-list'), 9, true);
      rows(el('dimopt-list'), 4, false);
      el('chatopt-note').textContent = 'These settings apply only to Test Streamer.';
      UIPolish.chatIdentity('Test Streamer', '');
      var headerNode = el('ui-chat-heading');
      UIPolish.chatIdentity('Test Streamer', '');
      assert(el('ui-chat-heading') === headerNode, 'repeated chat identity updates preserve header nodes');
      assert(el('ui-chat-name').textContent === 'Test Streamer', 'chat settings identify the active streamer in the header');
      assert(el('ui-chat-avatar').textContent === 'T', 'chat identity has an initial fallback without a remote image');
      assert(root.getComputedStyle(el('chatopt-note')).color === 'rgb(226, 200, 142)', 'streamer-specific warning remains amber');
      el('chatoptmodal').classList.remove('hidden');
      UIPolish.place(el('chatoptbox'));
      var chatList = el('chatopt-list');
      assert(chatList.scrollHeight > chatList.clientHeight, 'large chat controls use a bounded scroll area');
      chatList.scrollTop = chatList.scrollHeight;
      assert(rect(chatList.lastElementChild).bottom <= rect(chatList).bottom + 1, 'last chat control remains reachable by scrolling');
      assert(rect(el('chatopt-note')).bottom <= root.innerHeight - 23, 'chat warning stays on screen below scrolling controls');
      assert(root.getComputedStyle(el('chatoptbox')).backgroundColor === root.getComputedStyle(el('settingsbox')).backgroundColor, 'chat and Settings share the panel surface');
      assert(root.getComputedStyle(el('settingsbox')).backgroundColor === root.getComputedStyle(el('dimoptbox')).backgroundColor, 'Dim shares the panel surface');
      var row = el('qualityopt-list').children[0]; row.classList.add('selected');
      assert(root.getComputedStyle(row).borderColor !== 'rgb(83, 252, 24)', 'selected quality does not claim the focus edge');
      row.classList.add('focused');
      assert(root.getComputedStyle(row).borderColor === 'rgb(83, 252, 24)', 'focus owns the green edge on selected quality');
      var tool = el('settings-list').children[0]; tool.children[1].classList.add('on');
      assert(root.getComputedStyle(tool.children[1]).backgroundColor !== 'rgb(83, 252, 24)', 'enabled pills stay quieter than the focus edge');
      assert(root.getComputedStyle(tool).transitionDuration === '0s', 'setting focus changes are immediate');
      el('chatoptmodal').classList.add('hidden');
      var tools = el('player-tools'); tools.classList.remove('hidden');
      assert(rect(tools).bottom <= root.innerHeight - 24, 'player tools stay inside the viewport');
      tools.classList.add('hidden');
      panel = doc.createElement('div'); panel.style.cssText = 'position:fixed;left:1850px;top:1000px;width:360px;height:180px;background:#11181d';
      fixture.appendChild(panel);
      anchor = doc.createElement('div'); anchor.style.cssText = 'position:fixed;left:700px;top:350px;width:200px;height:100px';
      anchor.setAttribute('aria-describedby', 'existing-description'); fixture.appendChild(anchor);
      var moved = UIPolish.place(panel, anchor);
      assert(moved.left >= 24 && moved.right <= root.innerWidth - 24, 'floating panel stays inside viewport horizontally');
      assert(moved.top >= 24 && moved.bottom <= root.innerHeight - 24, 'floating panel stays inside the viewport vertically');
      var chat = el('chat'); chat.className = 'on'; chat.style.cssText = 'position:fixed;left:300px;top:280px;width:380px;height:400px;display:block;opacity:1;visibility:visible';
      UIPolish.place(panel, anchor);
      assert(!intersects(rect(panel), rect(chat)), 'placement avoids visible chat when a clear alternative exists');
      assert(!intersects(rect(panel), rect(anchor)), 'placement keeps the anchor control visible');
      chat.classList.add('hidden'); panel.style.display = 'none';
      UIPolish.details('browse', { id: 1, session_title: longTitle, categories: [{ name: 'Just Chatting' }] }, anchor);
      assert(!el('ui-details') || el('ui-details').classList.contains('hidden'), 'full details do not appear immediately');
      return wait(250);
    }).then(function () {
      UIPolish.cancelDetails();
      return wait(500);
    }).then(function () {
      assert(!el('ui-details') || el('ui-details').classList.contains('hidden'), 'leaving before dwell cancels late details');
      preference.dim = true; preference.dimScope = 'all'; preference.dimStrength = 0.95;
      UIPolish.details('browse', { id: 1, session_title: longTitle }, anchor);
      return wait(720);
    }).then(function () {
      var details = el('ui-details');
      assert(details && !details.classList.contains('hidden'), 'full details appear after a stable dwell');
      assert(parseFloat(root.getComputedStyle(details).filter.replace(/[^0-9.]/g, '')) < 0.1, 'details inherit strong night dimming when first shown');
      preference.dim = false; applyDimAwareUi();
      assert(!details.style.filter, 'existing details respond when dimming changes');
      assert(details.querySelector('.ui-details-title').textContent === longTitle, 'details preserve the complete title');
      assert(anchor.getAttribute('aria-describedby') === 'existing-description ui-details', 'details preserve existing accessible descriptions');
      descriptionBefore = details.children[0];
      var before = rect(details);
      UIPolish.details('browse', { id: 1, session_title: longTitle }, anchor);
      assert(details.children[0] === descriptionBefore && rect(details).left === before.left, 'same focused item retains stable details without rebuilding or moving');
      UIPolish.cancelDetails();
      assert(anchor.getAttribute('aria-describedby') === 'existing-description', 'cancelling details restores the original accessible description');
      UIPolish.details('browse', { id: 2, session_title: 'Removed card' }, anchor);
      anchor.parentNode.removeChild(anchor);
      return wait(720);
    }).then(function () {
      assert(el('ui-details').classList.contains('hidden'), 'detached virtual cards never display stale details');
      restore();
      return { suite: 'visual', passed: true };
    }).catch(function (error) { restore(); throw error; });
  };
}(window));
