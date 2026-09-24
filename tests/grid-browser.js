/* Synthetic catalogue and virtualization fixtures. No device or real account data. */
window.runGridTests = async function (assert) {
  var saved = { serviceGet: serviceGet, pause: pausePlaybackForBrowse, resume: resumePlaybackAfterBrowse,
    play: play, playVod: playVod, toast: toast, preview: fetchPreviewUrl, sidebar: closeSidebar, image: catalogueImage };
  var pending = [], selected = null, host = null;
  function wait() { return new Promise(function (done) { setTimeout(done, 35); }); }
  function stream(i) { return { channel: { slug: 'fixture-' + i, user: { username: 'Fixture ' + i } },
    viewer_count: 10000 - i, language: i % 2 ? 'English' : 'Turkish', session_title: 'Synthetic live title ' + i,
    categories: [{ slug: 'cat-' + (i % 8), name: 'Category ' + (i % 8) }], thumbnail: null, created_at: '2026-09-12 12:00:00' }; }
  function category(i) { return { slug: 'category-' + i, name: 'Synthetic category ' + i, viewers: 1000 - i, banner: null }; }
  function vod(i) { return { id: i, video: { uuid: 'fixture-vod-' + i }, source: 'https://fixture.invalid/vod-' + i + '.m3u8',
    session_title: 'Synthetic past video with a long complete title ' + i, duration: 3600000, views: i, created_at: '2026-09-12 12:00:00' }; }
  function range(n, make) { var out = []; for (var i = 0; i < n; i++) out.push(make(i)); return out; }
  function request(part) { for (var i = 0; i < pending.length; i++) if (pending[i].path.indexOf(part) !== -1) return pending.splice(i, 1)[0]; throw new Error('Missing request ' + part); }
  function mounted(view) { return view.content.children.length; }
  try {
    serviceGet = function (path, cb, opts) { pending.push({ path: path, cb: cb, opts: opts }); return { cancel: function () {} }; };
    pausePlaybackForBrowse = function () {}; resumePlaybackAfterBrowse = function () {};
    closeSidebar = function () {}; toast = function () {}; fetchPreviewUrl = function () {};
    play = function (slug) { selected = slug; };
    playVod = function (v, queue, index, slug) { selected = { v: v, queue: queue, index: index, slug: slug }; };
    state.ready = true; settings.hideBots = false;
    localStorage.setItem('kicktv.pinnedcats', '[]');
    localStorage.setItem('kicktv.browselang', '[]');
    localStorage.setItem('kicktv.browsediscover', '0');
    localStorage.setItem('kicktv.browsehideblocked', '0');
    localStorage.setItem('kicktv.vodhidewatched', '0');
    host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;width:1740px;height:800px;overflow:hidden;z-index:999';
    document.body.appendChild(host);
    var grid = new VirtualGrid(host, { columns: 4 });
    var records = range(2000, function (i) { return { id: 'key-' + i, title: 'Item ' + i }; });
    var made = 0;
    function create(item) { made++; var node = document.createElement('div'); node.className = 'bcard'; node.textContent = item.title; return node; }
    grid.setItems(records, function (x) { return x.id; }, create, function (node, item) { node.textContent = item.title; });
    assert(mounted(grid) <= 24, 'virtual grid mounts only viewport and one overscan row');
    var first = grid.get(0), initialMade = made;
    grid.setItems(records.slice(), function (x) { return x.id; }, create, function (node, item) { node.textContent = item.title; });
    assert(grid.get(0) === first && made === initialMade, 'unchanged keyed items retain DOM nodes');
    grid.focus(1999);
    assert(grid.get(1999).getAttribute('data-idx') === '1999' && !grid.get(0), 'deep focus uses absolute item index and recycles earlier cards');
    assert(mounted(grid) <= 24, 'deep scroll DOM remains bounded');
    grid.focus(0);
    assert(grid.get(0) && host.scrollTop === 0 && mounted(grid) <= 24, 'backwards scrolling remounts the beginning');
    host.scrollTop = 60000; grid.refresh();
    assert(mounted(grid) <= 24 && !grid.get(0), 'pointer scrolling also recycles distant focused cards');
    grid.focus(0); var oldPitch = grid.metrics.pitchY;
    document.body.classList.add('ui-text-large'); await wait();
    assert(grid.metrics.pitchY > oldPitch, 'larger text invalidates the cached fixed card geometry');
    document.body.classList.remove('ui-text-large'); await wait();
    grid.clear(); assert(mounted(grid) === 0 && host.scrollTop === 0, 'clear releases mounted rows and resets scroll');
    host.parentNode.removeChild(host); host = null;

    openBrowse();
    assert(document.querySelectorAll('#browse-grid .bskel').length === 8, 'Browse first load uses bounded static skeletons');
    request('/stream/').cb(null, { data: range(50, stream) });
    await wait(); loadBrowseMore();
    var page2 = request('page=2');
    page2.cb(new Error('fixture failure'));
    assert(browse.error && getBrowseGrid().items[browse.streams.length].retry, 'Browse failures preserve cards and expose explicit Retry');
    browse.gridIdx = browse.streams.length; browse.zone = 'grid'; browseActivate();
    request('page=2').cb(null, { data: range(50, function (i) { return stream(i + 50); }) });
    assert(browse.raw.length === 100 && !browse.error, 'Browse Retry retries the failed page without duplicate records');
    cancelBrowseFill(); browse.hasMore = false; browse.raw = range(1000, stream); renderBrowse();
    browse.gridIdx = 801; applyBrowseFocus();
    assert(getBrowseGrid().get(801) && mounted(getBrowseGrid()) <= 24, 'Browse deep remote selection has bounded DOM');
    var browseScroll = getBrowseGrid().container.scrollTop;
    getBrowseGrid().container.scrollTop = 0; getBrowseGrid().refresh();
    getBrowseGrid().container.scrollTop = browseScroll; getBrowseGrid().refresh(); browseMove(1, 0);
    assert(getBrowseGrid().content.querySelectorAll('.focused').length === 1 && browseFocusEl === getBrowseGrid().get(browse.gridIdx), 'Browse remount then D-pad movement keeps exactly one focus');
    var focusedSlug = catalogueKey(browse.streams[browse.gridIdx]);
    browse.raw.push(stream(-1)); renderBrowse(true);
    assert(catalogueKey(browse.streams[browse.gridIdx]) === focusedSlug, 'late live pages preserve focused streamer identity through sorting');
    cycleBrowseSort();
    assert(catalogueKey(browse.streams[browse.gridIdx]) === focusedSlug, 'Browse sort changes preserve focused identity');
    var peekDone = null, peekSlug = null;
    fetchPreviewUrl = function (slug, done) { peekSlug = slug; peekDone = done; };
    browse.gridIdx = 5; applyBrowseFocus();
    await new Promise(function (done) { setTimeout(done, 830); });
    assert(!!peekDone, 'Browse focus starts the delayed synthetic preview');
    browse.raw = browse.raw.filter(function (item) { return catalogueKey(item) !== peekSlug; }); renderBrowse();
    var imageWrites = 0; catalogueImage = function () { imageWrites++; };
    previewCache[peekSlug] = { t: Date.now(), url: 'https://fixture.invalid/stale-image.png' }; peekDone();
    assert(imageWrites === 0, 'late Browse preview cannot overwrite a different streamer at the same index');
    delete previewCache[peekSlug]; catalogueImage = saved.image; fetchPreviewUrl = function () {}; clearTimeout(browsePeekTimer);
    browse.zone = 'header'; browse.headerIdx = 0;
    for (var h = 0; h < BROWSE_HEADERS.length; h++) {
      assert(document.getElementById(BROWSE_HEADERS[h]) !== null, 'Browse header control exists ' + h);
      if (h) browseMove(1, 0);
      assert(browse.headerIdx === h, 'D-pad reaches Browse header control ' + h);
    }
    var pins = range(8, function (i) { return { slug: 'cat-' + i, name: 'A very long synthetic pinned category ' + i }; });
    savePinnedCats(pins); renderPinnedCatChips(); browse.zone = 'pins'; browse.pinIdx = 0;
    for (var pi = 0; pi < 8; pi++) browseMove(1, 0);
    assert(browse.pinIdx === 8 && document.getElementById('browse-pinnedcats').scrollLeft > 0, 'all eight pinned chips are remotely reachable in a scrolling strip');
    browse.zone = 'grid'; browse.gridIdx = 600; applyBrowseFocus();
    var expected = catalogueKey(browse.streams[600]);
    getBrowseGrid().get(600).querySelector('.bname').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert(selected === expected, 'deep Browse pointer activation opens the logical streamer');

    browse.closedAt = 0; openBrowse(); var stale = request('page=1'); closeBrowse();
    openBrowse(); var current = request('page=1'); stale.cb(null, { data: [stream(4444)] });
    assert(!browse.raw.length && browse.fetching, 'closed Browse response cannot clear or replace a new request');
    current.cb(null, { data: range(CATALOGUE_LIMIT + 100, stream) }); cancelBrowseFill();
    assert(browse.raw.length === CATALOGUE_LIMIT && !browse.hasMore && browse.capped, 'Browse metadata pool has an explicit bounded limit');
    browse.langs = ['Language with no matches']; renderBrowse();
    assert(!browse.streams.length && getBrowseGrid().items[0].message.indexOf('limit') !== -1, 'exhausted filters report the directory limit honestly');
    browse.langs = []; browse.cats = []; renderBrowse();

    openCats(); request('/api/v1/subcategories?page=1').cb(null, { data: range(32, category) });
    request('/api/v1/subcategories?page=2').cb(null, { data: range(32, function (i) { return category(i + 32); }) });
    cats.list = range(600, category); cats.hasMore = false; renderCats(); cats.gridIdx = 501; applyCatsFocus();
    assert(getCatsGrid().get(501) && mounted(getCatsGrid()) <= 32, 'Categories deep focus uses absolute indexes with bounded cards');
    var catScroll = getCatsGrid().container.scrollTop;
    getCatsGrid().container.scrollTop = 0; getCatsGrid().refresh();
    getCatsGrid().container.scrollTop = catScroll; getCatsGrid().refresh(); catsMove(1, 0); catsMove(-1, 0);
    assert(getCatsGrid().content.querySelectorAll('.focused').length === 1 && catsFocusEl === getCatsGrid().get(cats.gridIdx), 'Categories remount then D-pad movement keeps exactly one focus');
    var categoryIdentity = cats.focusKey, oldCat = getCatsGrid().get(501), oldScroll = getCatsGrid().container.scrollTop;
    closeCats(); openCats();
    assert(getCatsGrid().get(501) === oldCat && getCatsGrid().container.scrollTop === oldScroll, 'warm Categories reopen preserves DOM, focus, and scroll');
    var refresh = request('/api/v1/subcategories?page=1');
    assert(refresh.opts.priority === 2, 'warm Categories refresh runs quietly at background priority');
    refresh.cb(null, { data: [category(999)].concat(range(31, category)) });
    assert(cats.focusKey === categoryIdentity, 'Categories refresh preserves focused slug when ordering shifts');
    cats.page = 4; refreshCats(); request('/api/v1/subcategories?page=1').cb(new Error('fixture refresh failure'));
    assert(cats.error && cats.refreshError, 'warm Categories failure records the refresh request origin');
    cats.gridIdx = getCatsGrid().items.length - 1; cats.zone = 'grid'; applyCatsFocus(); catsActivate();
    var refreshRetry = request('/api/v1/subcategories?page=1');
    assert(refreshRetry.opts.priority === 2 && !pending.some(function (req) { return req.path.indexOf('subcategories?page=4') !== -1; }), 'warm Categories Retry repeats page one instead of the next pagination page');
    refreshRetry.cb(null, { data: range(32, category) });
    cats.query = 'missing'; cats.results = []; cats.focusKey = null; cats.gridIdx = 0;
    runCatsSearch('missing'); request('/api/search').cb(new Error('fixture search failure'));
    assert(cats.searchError && getCatsGrid().items[1].retry, 'category search failures are distinct from empty results');
    cats.gridIdx = 1; cats.zone = 'grid'; catsActivate(); request('/api/search').cb(null, { categories: [] });
    assert(!cats.searchError && getCatsGrid().items[1].message === 'No categories match', 'category Retry resolves to precise empty search state');
    cats.query = ''; cats.results = null; cats.focusKey = null; cats.gridIdx = 3; renderCats(); catsActivate();
    assert(hasBrowseCat(displayedCats()[2].slug), 'category logical index toggles its matching Browse filter');
    cats.gridIdx = 401; applyCatsFocus();
    var pinTarget = displayedCats()[400].slug;
    getCatsGrid().get(401).querySelector('[data-act=catpin]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert(isCatPinned(pinTarget), 'deep category pointer pin uses absolute index instead of mounted child offset');
    cats.list = []; cats.page = 1; cats.hasMore = true; cats.error = false; cats.focusKey = null; cats.gridIdx = 0; loadCatsMore(false);
    request('/api/v1/subcategories?page=1').cb(new Error('fixture page failure'));
    assert(cats.error && !cats.refreshError, 'category page failure retains its pagination retry origin');
    cats.gridIdx = getCatsGrid().items.length - 1; cats.zone = 'grid'; applyCatsFocus(); catsActivate();
    request('/api/v1/subcategories?page=1').cb(null, { data: range(CATS_LIMIT + 100, category) });
    assert(cats.list.length === CATS_LIMIT && cats.capped && !cats.hasMore, 'Categories pool stops at its explicit bound');
    closeCats(); closeBrowse();

    openVods('fixture-channel');
    assert(document.querySelectorAll('#vods-grid .bskel').length === 8, 'VOD first load uses static skeleton cards');
    request('/videos').cb(null, range(450, vod).concat([{ id: 'gated', source: '' }]));
    assert(vods.listAll.length === VOD_CATALOGUE_LIMIT && vods.hidden === 1 && vods.capped, 'VOD metadata is bounded and source-less recordings stay hidden');
    vods.gridIdx = 301; applyVodFocus();
    assert(getVodGrid().get(301) && mounted(getVodGrid()) <= 24, 'deep VOD navigation mounts a bounded window');
    var remountVodScroll = getVodGrid().container.scrollTop;
    getVodGrid().container.scrollTop = 0; getVodGrid().refresh();
    getVodGrid().container.scrollTop = remountVodScroll; getVodGrid().refresh(); vodMove(1, 0); vodMove(-1, 0);
    assert(getVodGrid().content.querySelectorAll('.focused').length === 1 && vodsFocusEl === getVodGrid().get(vods.gridIdx), 'VOD remount then D-pad movement keeps exactly one focus');
    var vodNode = getVodGrid().get(301), vodScroll = getVodGrid().container.scrollTop;
    closeVods(); openVods('fixture-channel');
    assert(getVodGrid().get(301) === vodNode && getVodGrid().container.scrollTop === vodScroll, 'warm VOD reopen preserves DOM, focus, and scroll');
    var vodRefresh = request('/videos'); assert(vodRefresh.opts.priority === 2, 'warm VOD refresh uses background priority');
    vodRefresh.cb(null, [vod(999)].concat(range(399, vod)));
    assert(vodStableId(vods.list[vods.gridIdx]) === 'fixture-vod-301', 'VOD refresh retains focused recording identity');
    vods.zone = 'grid'; vodActivate();
    assert(selected.v.video.uuid === 'fixture-vod-301' && selected.queue[selected.index] === selected.v, 'VOD activation preserves exact visible queue and absolute selection');
    openVods('fixture-errors'); request('/videos').cb(new Error('fixture failure'));
    assert(vods.error && getVodGrid().items[0].retry, 'failed VOD load has an actionable Retry card');
    vods.gridIdx = 0; vods.zone = 'grid'; vodActivate(); request('/videos').cb(null, []);
    assert(!vods.error && !getVodGrid().items.length && document.getElementById('vods-status').textContent === 'No past videos' && vods.zone === 'header', 'VOD Retry distinguishes a successful empty list');
    closeVods();
    for (var cacheIndex = 0; cacheIndex < 6; cacheIndex++) {
      openVods('fixture-cache-' + cacheIndex); request('/videos').cb(null, [vod(cacheIndex)]); closeVods();
    }
    assert(vodCatalogueOrder.length === 4 && !vodCatalogueCache['$fixture-cache-0'], 'warm VOD cache evicts oldest entries beyond four channels');
  } finally {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (browse.open) closeBrowse(); if (cats.open) closeCats(); if (vods.open) closeVods();
    cancelBrowseFill(); clearTimeout(browsePeekTimer); clearTimeout(catsSearchTimer);
    serviceGet = saved.serviceGet; pausePlaybackForBrowse = saved.pause; resumePlaybackAfterBrowse = saved.resume;
    play = saved.play; playVod = saved.playVod; toast = saved.toast; fetchPreviewUrl = saved.preview; closeSidebar = saved.sidebar; catalogueImage = saved.image;
  }
};
