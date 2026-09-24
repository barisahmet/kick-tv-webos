window.runSettingsTests = async function (assert) {
  function el(id) { return document.getElementById(id); }
  function click(node) { assert(!!node, 'control exists'); node.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  function key(code) { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, keyCode: code })); }
  function rowFor(keyName) {
    var index = settings.items.map(function (it) { return it.key || it.kind; }).indexOf(keyName);
    return el('settings-list').children[index];
  }
  function chatRow(keyName) {
    return el('chatopt-list').children[CHATOPT_ROWS.map(function (it) { return it.key; }).indexOf(keyName)];
  }
  fixtureStore['kicktv.settings'] = JSON.stringify({ uiText: 'large', subtitleSafe: true });
  loadSettings(); UIPolish.apply(); openSettings();
  var big = rowFor('uiText').querySelector('[role="switch"]');
  assert(big && big.getAttribute('aria-checked') === 'true', 'Big UI restores the existing large text preference');
  function alignedValues() {
    var values = el('settings-list').querySelectorAll('.spill');
    var first = values[0].getBoundingClientRect(), right = first.right;
    return Array.prototype.every.call(values, function (value) {
      var r = value.getBoundingClientRect(); return Math.abs(r.right - right) < 1;
    });
  }
  assert(alignedValues(), 'all switches and choice values share one right edge in Big UI');
  click(big);
  assert(settings.uiText === 'normal' && !document.body.classList.contains('ui-text-large'), 'Big UI switch turns large text off immediately');
  assert(alignedValues(), 'all switches and choice values share one right edge at normal size');
  assert(JSON.parse(fixtureStore['kicktv.settings']).uiText === 'normal', 'Big UI retains compatible stored values');
  assert(!('subtitleSafe' in JSON.parse(fixtureStore['kicktv.settings'])), 'removed subtitle preference is omitted from future saves');
  key(39);
  assert(settings.uiText === 'large' && rowFor('uiText').querySelector('[role="switch"]').getAttribute('aria-checked') === 'true', 'remote Right toggles Big UI back on');
  click(rowFor('hideBots').querySelector('[role="switch"]'));
  assert(settings.hideBots === false && JSON.parse(fixtureStore['kicktv.settings']).hideBots === false, 'global boolean switch persists its disabled state');
  var initialChat = settings.chat;
  click(rowFor('chatopt').querySelector('[role="switch"]'));
  assert(settings.chat !== initialChat && !chatopt.open, 'chat switch toggles without opening its subpage');
  click(rowFor('chatopt').querySelector('.slabel'));
  assert(chatopt.open, 'chat label opens its subpage');
  var cases = [['chatBackground', 'white', 'black'], ['chatBots', 'hide', 'show'], ['chatEmotes', 'images', 'text']];
  cases.forEach(function (entry) {
    settings[entry[0]] = entry[2]; renderChatOpt();
    click(chatRow(entry[0]).querySelector('[role="switch"]'));
    assert(settings[entry[0]] === entry[1], entry[0] + ' enabled maps to the intended choice');
    assert(chatRow(entry[0]).querySelector('[role="switch"]').getAttribute('aria-checked') === 'true', entry[0] + ' shows enabled state');
    click(chatRow(entry[0]).querySelector('[role="switch"]'));
    assert(settings[entry[0]] === entry[2], entry[0] + ' disabled maps to the alternative');
  });
  settings.chatBackground = 'white'; saveSettings(); closeChatOpt();
  state.current = 'beta'; applyStreamerChatPreferences();
  assert(settings.chatBackground === 'black', 'chat switch choices remain separate for each streamer');
  state.current = 'alpha'; applyStreamerChatPreferences();
  assert(settings.chatBackground === 'white', 'returning restores streamer switch choices');
  click(rowFor('dimopt').querySelector('.slabel'));
  assert(dimopt.open, 'Dim row label opens options');
  settings.dimScope = 'video'; renderDimOpt();
  click(el('dimopt-list').children[2].querySelector('[role="switch"]'));
  assert(settings.dimScope === 'all' && JSON.parse(fixtureStore['kicktv.settings']).dimScope === 'all', 'Dim everything switch persists the existing scope value');
  closeDimOpt(); click(rowFor('blockedcats').querySelector('.slabel'));
  assert(blockedcats.open, 'blocked categories label opens its subpage');
  closeBlockedCats(); closeSettings();
  settings.uiText = 'normal'; UIPolish.apply();
  var anchor = document.createElement('div'); anchor.style.cssText = 'position:fixed;left:600px;top:200px;width:300px;height:200px'; document.body.appendChild(anchor);
  catalogueDetails('vod', { id: 1, session_title: 'A VOD title' }, anchor);
  await fixtureWait(750);
  assert(!el('ui-details') || el('ui-details').classList.contains('hidden'), 'VOD focus never opens a tooltip');
  anchor.remove();
  // A cached frame isolates placement from the network and image decode timing.
  var image = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  previewCache.beta = { t: Date.now(), url: image };
  openSidebar(); state.sideFocus = state.sideItems.map(function (it) { return it.slug; }).indexOf('beta'); applySideFocus();
  await fixtureWait(400);
  var preview = el('sidepreview').getBoundingClientRect(), row = el('fav-list').children[state.sideFocus].getBoundingClientRect();
  assert(!el('sidepreview').classList.contains('hidden'), 'hover preview is visible');
  assert(Math.abs(preview.top + preview.height / 2 - row.top - row.height / 2) < 120, 'top sidebar preview stays beside its row');
  assert(preview.left >= el('sidebar').getBoundingClientRect().right && preview.bottom <= 1056, 'preview clears the sidebar and screen edge');
  var previewRow = el('fav-list').children[state.sideFocus];
  previewRow.style.transform = 'translateY(700px)';
  positionStreamPreview(el('sidepreview'), previewRow, el('sidebar'));
  assert(el('sidepreview').getBoundingClientRect().bottom <= 1056, 'preview near the bottom is clamped inside the screen');
  previewRow.style.transform = '';
  positionStreamPreview(el('sidepreview'), previewRow, el('sidebar'));
  assert(el('sidepreview').getBoundingClientRect().top === preview.top, 'moving back to a top row resets preview placement');
  var current = el('fav-list').querySelector('.current');
  assert(getComputedStyle(current).borderLeftColor === 'rgb(83, 252, 24)', 'playing stream retains a green left indicator');
  assert(getComputedStyle(current.querySelector('.favname'), '::before').content === 'none', 'playing stream has no triangle');
  closeSidebar(); openSettings();
};
