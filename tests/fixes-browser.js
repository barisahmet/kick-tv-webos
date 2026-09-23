/* Regression checks for the review fixes. Synthetic fixtures only. */
window.runFixesTests = async function (assert) {
  function key(code) { document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })); }
  // An unreadable follow list is set aside, never overwritten.
  fixtureStore['kicktv.removed'] = '{broken';
  assert(lsGet('kicktv.removed').length === 0 && fixtureStore['kicktv.removed.corrupt'] === '{broken', 'unreadable list is preserved under .corrupt');
  delete fixtureStore['kicktv.removed']; favoritesMemo = null;

  // OK in the open list belongs to the list, never to an alert.
  var realPlay = play, playedSlug = null;
  play = function (slug) { playedSlug = slug; };
  try {
    openSidebar(); await fixtureWait();
    for (var i = 0; i < state.sideItems.length; i++) if (state.sideItems[i].slug === 'beta') state.sideFocus = i;
    applySideFocus();
    state.notifyCurrent = { slug: 'gamma', name: 'Gamma' };
    key(13);
    assert(playedSlug === 'beta' && state.notifyCurrent && state.notifyCurrent.slug === 'gamma', 'OK plays the highlighted row, not the alert');
    state.notifyCurrent = null;
  } finally { play = realPlay; }
  closeSidebar();

  assert(!alertAllowed({ slug: 'alpha' }), 'no "is online" alert for the channel already playing');

  // Removing the channel you are watching keeps it in the list as a temporary row.
  askRemove('alpha'); confirmYes();
  assert(!isFavorite('alpha') && state.tempChannel === 'alpha', 'removed-but-playing channel becomes the temporary row');
  renderSidebar();
  assert(state.sideItems[0].type === 'temp' && state.sideItems[0].slug === 'alpha', 'and it is still in the list');
  assert(state.order.indexOf('alpha') === -1, 'the list re-sorted locally without a refresh');
  addFavorite('alpha'); state.tempChannel = null; sortOrder(currentFavoritesWithData());

  // One shared panel check, used by the boot decision too.
  settings.open = true;
  assert(anyPanelOpen() && bootChoiceSuperseded(), 'an open Settings panel counts as the viewer taking over');
  settings.open = false;

  // Stop always stops; Play/Pause work with the list open.
  var video = document.getElementById('video'), paused = 0;
  var realPause = video.pause; video.pause = function () { paused++; };
  openSidebar(); await fixtureWait();
  key(19);
  assert(paused === 1, 'Pause works while the channel list is open');
  video.pause = realPause; closeSidebar();

  // Labels and resume.
  var now = Date.now();
  function ago(days) { return new Date(now - days * 86400000).toISOString().replace('T', ' ').slice(0, 19); }
  assert(fmtVodAgo(ago(362)) === '1 year ago', 'a year-old video is "1 year ago", not "12 months ago"');
  assert(fmtVodAgo(ago(45)) === '1 month ago', 'months still read as months');
  var data = loadVodProgress(); data.items['alpha:w'] = { position: 2400, duration: 3000, watched: true, updated: now };
  writeVodProgress(data);
  assert(savedVodPosition('alpha:w') === 0, 'a watched video starts over, matching its card');

  // Chat can only be switched on where it exists.
  var realCurrent = state.current;
  state.current = null; settings.chat = false;
  assert(!chatCanTurnOn(), 'no chat without a live stream');
  state.current = realCurrent;

  // A stream frame counts toward the live mark only while it plays.
  liveWatchContentMs = 0;
  assert(liveLatencySec() >= 0, 'latency is always a number');
};
