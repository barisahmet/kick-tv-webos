window.runHotpathsTests = async function (assert) {
  var realService = serviceGet, realFrame = loadPreviewFrame, requests = [], frames = [], callbacks = 0;
  serviceGet = function (path, done, options) { requests.push({ path: path, done: done, options: options }); };
  loadPreviewFrame = function (url, done) { frames.push({ url: url, done: done }); };
  previewCache = {}; previewPending = Object.create(null);
  try {
    fetchPreviewUrl('one', function () { callbacks++; });
    fetchPreviewUrl('one', function () { callbacks++; });
    assert(requests.length === 1, 'two preview consumers share one request');
    requests[0].done(null, { livestream: { thumbnail: { url: 'fixture:one' } } });
    assert(callbacks === 0 && frames.length === 1, 'preview consumers wait for image preparation');
    frames[0].done(fixtureFrame(), null);
    assert(callbacks === 2 && previewCache.one.ready, 'prepared preview reaches both consumers');
    fetchPreviewUrl('one'); requests[1].done(null, { livestream: { thumbnail: { url: 'fixture:one' } } });
    assert(frames.length === 1, 'unchanged thumbnail reuses the decoded frame');
    fetchPreviewUrl('one'); requests[2].done(null, { livestream: { thumbnail: { url: 'fixture:new' } } });
    frames[1].done(null, null);
    assert(previewCache.one.url === 'fixture:one' && previewCache.one.ready, 'failed refresh preserves the last good frame');
    assert(requests.every(function (r) { return r.options.priority === 3; }), 'idle previews stay below channel-list work');
    fetchPreviewUrl('urgent', null, true);
    assert(requests[3].options.priority === 1, 'visible previews receive foreground priority');
    requests[3].done(null, { livestream: { thumbnail: { url: 'fixture:urgent' } } });
    frames[2].done(fixtureFrame(), null);
    prunePreviews(['urgent']);
    assert(!previewCache.one && previewCache.urgent, 'pruning keeps only current preview targets');
  } finally { serviceGet = realService; loadPreviewFrame = realFrame; }

  var originalFetch = fetchFavorites, refreshes = 0, lastPartial = null;
  fetchFavorites = function (done, partial) { refreshes++; lastPartial = partial; if (done) done(); };
  state.lastFetch = Date.now() - 10000; renderSidebar(); openSidebar(); await fixtureWait();
  assert(refreshes === 0, 'opening sidebar reuses ten-second-old channel metadata');
  closeSidebar(); state.lastFetch = Date.now() - 61000; openSidebar(); await fixtureWait();
  assert(refreshes === 1, 'opening stale sidebar refreshes after reveal');
  closeSidebar();

  var interval = window.setInterval, tick, originalTick = playerPollTick;
  window.setInterval = function (fn) { tick = fn; return 0; };
  playerPollTick = 0; refreshes = 0; startPlayerPoll();
  window.setInterval = interval;
  tick(); tick(); tick();
  assert(refreshes === 0, 'quiet playback skips the first three directory polling ticks');
  tick();
  assert(refreshes === 1 && lastPartial === false, 'two-minute quiet poll includes offline channels for live alerts');
  state.vod = { slug: 'alpha' }; var alerts = settings.alerts; settings.alerts = 'off';
  tick(); tick(); tick(); tick();
  assert(refreshes === 1, 'VOD with alerts off performs no directory polling');
  state.vod = null; settings.alerts = alerts; playerPollTick = originalTick; fetchFavorites = originalFetch;

  var realApi = apiGet, order = [], complete = false;
  state.channels.offline = { slug: 'offline', name: 'Offline', live: false };
  state.channels.pin = { slug: 'pin', name: 'Pin', live: true };
  state.channels.live = { slug: 'live', name: 'Live', live: true };
  lsSet('kicktv.added', ['offline', 'live', 'pin', 'beta', 'alpha']); savePinned(['pin']);
  state.current = 'alpha'; state.sidebarOpen = true; state.sideItems = [{ type: 'chan', slug: 'beta' }]; state.sideFocus = 0;
  apiGet = function (slug, done, options) { order.push({ slug: slug, options: options, done: done }); };
  runFetchFavorites(function () { complete = true; });
  assert(order.map(function (r) { return r.slug; }).join(',') === 'alpha,beta,pin,live,offline', 'channel refresh prioritizes current, focused, pinned, live, then offline');
  assert(order.every(function (r) { return r.options.priority === 1; }), 'open sidebar metadata uses active-screen priority');
  order.forEach(function (request) { request.done(null, { user: { username: request.slug }, livestream: null }); });
  assert(complete, 'priority refresh completes once every requested channel responds');
  apiGet = realApi; state.sidebarOpen = false;
};
