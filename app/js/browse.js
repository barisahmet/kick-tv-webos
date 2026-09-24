'use strict';
/* Browse live streams (blue button) */
// Kick's directory has no language filter, so we pull the top live streams
// (sorted by viewers) and filter by language here on the TV.
var BROWSE_LANGS = [
  { label: 'All',      value: 'all' },
  { label: 'English',  value: 'English' },
  { label: 'Türkçe',   value: 'Turkish' },
  { label: 'Espanol',  value: 'Spanish' },
  { label: 'Portugues',value: 'Portuguese' },
  { label: 'Arabic',   value: 'Arabic' },
  { label: 'Deutsch',  value: 'German' },
  { label: 'Russian',  value: 'Russian' }
];
var BROWSE_COLS = 4;
var BROWSE_MEMORY_MS = 60000;     // reopen inside this window and the loaded pool is reused
var browse = { open: false, langs: [], langIdx: 0, zone: 'grid', gridIdx: 0,
               raw: [], streams: [], page: 1, hasMore: true, fetching: false,
               cats: [], session: 0, closedAt: 0, scrollTop: 0, langMenuOpen: false,
               sort: 'viewers', discover: false, hideBlocked: true, renderLimit: 60,
               fillTimer: null, retryTimer: null, retryCount: 0, error: false, capped: false, headerIdx: 3, pinIdx: 0 };
var CATALOGUE_LIMIT = 2000;
var browseGridView = null, catsGridView = null, vodGridView = null;
var BROWSE_HEADERS = ['browse-cats-btn', 'browse-discover', 'browse-hideblocked', 'browse-langbtn', 'browse-close'];
function catalogueImage(el, url, label) {
  if (window.UIImages) UIImages.watch(el, url || '', label || 'Artwork unavailable');
  else if (url) el.style.backgroundImage = 'url(' + url + ')';
}
function catalogueKey(s) { return (s.channel && s.channel.slug) || s.slug || ''; }
function catalogueIdentityIndex(list, key, identity, fallback) {
  if (identity != null) for (var i = 0; i < list.length; i++) if (key(list[i], i) === identity) return i;
  return Math.max(0, Math.min(list.length - 1, fallback || 0));
}
function catalogueMove(index, n, cols, dx, dy) {
  if (!n) return 0;
  if (dx) return Math.max(0, Math.min(n - 1, index + dx));
  if (dy > 0) return Math.min(n - 1, index + cols);
  return Math.max(0, index - cols);
}
function catalogueUpdate(node, fresh) {
  if (window.UIImages) UIImages.release(node);
  node.className = fresh.className;
  node.setAttribute('data-base', fresh.getAttribute('data-base') || fresh.className);
  if (fresh.hasAttribute('role')) node.setAttribute('role', fresh.getAttribute('role')); else node.removeAttribute('role');
  while (node.firstChild) node.removeChild(node.firstChild);
  while (fresh.firstChild) node.appendChild(fresh.firstChild);
}
function catalogueTerminal(kind, msg, retry) {
  return { catalogueTerminal: true, kind: kind, message: msg, retry: !!retry };
}
function makeCatalogueTerminal(item) {
  var node = document.createElement('div');
  node.className = item.kind === 'cats' ? 'ccard catalogue-state' : 'bcard catalogue-state';
  node.setAttribute('data-base', node.className);
  node.setAttribute('role', item.retry ? 'button' : 'status');
  node.textContent = item.message + (item.retry ? ' · Retry' : '');
  node.style.display = 'flex'; node.style.alignItems = 'center'; node.style.justifyContent = 'center';
  node.style.padding = '24px'; node.style.fontSize = '25px'; node.style.textAlign = 'center';
  return node;
}
function catalogueSkeletons(view, kind) {
  var list = [];
  for (var i = 0; i < 8; i++) list.push({ skeleton: i });
  view.setItems(list, function (item) { return 'skeleton-' + item.skeleton; }, function () {
    var node = document.createElement('div');
    node.className = kind === 'cats' ? 'ccard cskel' : 'bcard bskel';
    node.innerHTML = kind === 'cats' ? '<div class="cbanner"></div>' : '<div class="bthumb"></div><div class="bmeta"><div class="skline w1"></div><div class="skline w2"></div></div>';
    node.setAttribute('data-base', node.className);
    node.style.animation = 'none';
    return node;
  });
}
function catalogueAnchoredScroll(view, nextIndex, key, saved) {
  var old = view.focused, m = view.metrics;
  if (m && old >= 0 && view.keys[old] === '$' + key && view.get(old)) {
    return Math.max(0, saved + (Math.floor(nextIndex / m.cols) - Math.floor(old / m.cols)) * m.pitchY);
  }
  return saved;
}
function catalogueMountedFocus(view, index, active, baseOf) {
  var next = view.get(index), focused = view.content.querySelectorAll('.focused');
  for (var i = 0; i < focused.length; i++) if (focused[i] !== next || !active) focused[i].className = baseOf(focused[i]);
  if (next && active) next.className = baseOf(next) + ' focused';
  return next;
}
function getBrowseGrid() {
  if (!browseGridView) browseGridView = new VirtualGrid(document.getElementById('browse-grid'), { columns: BROWSE_COLS, height: 350, onRender: function () {
    browseFocusEl = catalogueMountedFocus(browseGridView, browse.gridIdx, browse.zone === 'grid', browseCardBaseOf);
  } });
  return browseGridView;
}
var BROWSE_SORTS = [
  { key: 'viewers', label: 'Top' },
  { key: 'newest',  label: 'New' },
  { key: 'small',   label: 'Small' }
];
// The sort chip is gone from the header; Browse always orders by viewers. The
// sort machinery is left in place so the control can come back cheaply.
function renderBrowseSort() {
  var el = document.getElementById('browse-sort');
  if (!el) return;
  for (var i = 0; i < BROWSE_SORTS.length; i++) {
    if (BROWSE_SORTS[i].key === browse.sort) { el.textContent = 'Sort: ' + BROWSE_SORTS[i].label; return; }
  }
}
function cycleBrowseSort() {
  var idx = 0;
  for (var i = 0; i < BROWSE_SORTS.length; i++) if (BROWSE_SORTS[i].key === browse.sort) { idx = i; break; }
  var next = BROWSE_SORTS[(idx + 1) % BROWSE_SORTS.length];
  browse.sort = next.key;
  renderBrowseSort();
  renderBrowse();
  toast('Sort: ' + (next.key === 'viewers' ? 'Most viewers' : (next.key === 'newest' ? 'Recently started' : 'Small streams first')));
}
/* "Hide Followed": hide channels you already follow — browsing is for finding
   new ones. The preference persists across opens. */
function loadBrowseDiscoverPref() {
  try { return localStorage.getItem('kicktv.browsediscover') === '1'; } catch (e) { return false; }
}
function renderBrowseDiscover() {
  var el = document.getElementById('browse-discover');
  if (el) el.className = browse.discover ? 'on' : '';
}
function toggleBrowseDiscover() {
  browse.discover = !browse.discover;
  try { localStorage.setItem('kicktv.browsediscover', browse.discover ? '1' : '0'); } catch (e) {}
  renderBrowseDiscover();
  refilterBrowse();
  toast(browse.discover ? 'Hiding channels you follow' : 'Showing all channels');
}
/* "Hide Blocked": drop streams whose category you have blocked out of the grid.
   Blocking already sinks and greys a followed channel in your list, so seeing
   the same categories while browsing is noise — this one defaults ON. Picking a
   category on purpose still shows it (see renderBrowse). */
function loadBrowseHideBlockedPref() {
  try { return localStorage.getItem('kicktv.browsehideblocked') !== '0'; } catch (e) { return true; }
}
function renderBrowseHideBlocked() {
  var el = document.getElementById('browse-hideblocked');
  if (el) el.className = browse.hideBlocked ? 'on' : '';
}
function toggleBrowseHideBlocked() {
  browse.hideBlocked = !browse.hideBlocked;
  try { localStorage.setItem('kicktv.browsehideblocked', browse.hideBlocked ? '1' : '0'); } catch (e) {}
  renderBrowseHideBlocked();
  refilterBrowse();
  toast(browse.hideBlocked ? 'Hiding blocked categories' : 'Showing blocked categories');
}
// Static placeholders keep the first page geometry stable while loading.
function renderBrowseSkeletons() { catalogueSkeletons(getBrowseGrid(), 'browse'); }

// Selected languages persist as a JSON array; an empty selection means All.
// Older installs stored a single string — migrate it on load.
function loadBrowseLangPref() {
  var v = null;
  try { v = localStorage.getItem('kicktv.browselang'); } catch (e) {}
  browse.langs = [];
  if (v && v.charAt(0) === '[') {
    try {
      var arr = JSON.parse(v);
      for (var i = 0; i < arr.length; i++) {
        for (var j = 1; j < BROWSE_LANGS.length; j++) {
          if (BROWSE_LANGS[j].value === arr[i]) { browse.langs.push(arr[i]); break; }
        }
      }
    } catch (e2) {}
  } else if (v && v !== 'all') {
    for (var k = 1; k < BROWSE_LANGS.length; k++) {
      if (BROWSE_LANGS[k].value === v) { browse.langs.push(v); break; }
    }
  }
  browse.langIdx = 0;
}
function saveBrowseLangPref() { try { localStorage.setItem('kicktv.browselang', JSON.stringify(browse.langs)); } catch (e) {} }
function setBrowseStatus(msg) { document.getElementById('browse-status').textContent = msg || ''; }
// Kick ships a srcset with every thumbnail and banner, and the plain `src` is the
// 1280-wide one. A grid card is 376px across, so that default carries about eleven
// times the pixels it can ever show — sixty of them at a time, decoded on the main
// thread, is most of what opening a grid costs. Take the narrowest variant that
// still covers the card. (The preview window has always done this by hand; see
// pickPreviewUrl.)
var CARD_IMG_W = 400;   // .bcard and .ccard are 408px wide with a 4px border
function pickSrcsetUrl(srcset, minWidth) {
  var parts = String(srcset || '').split(',');
  var best = null, bestW = 0, widest = null, widestW = -1;
  for (var i = 0; i < parts.length; i++) {
    var m = /(\S+)\s+(\d+)w$/.exec(parts[i].trim());
    if (!m) continue;
    var w = parseInt(m[2], 10);
    if (w > widestW) { widestW = w; widest = m[1]; }
    if (w >= minWidth && (best === null || w < bestW)) { bestW = w; best = m[1]; }
  }
  return best || widest;   // nothing wide enough: take the biggest on offer
}
function thumbUrl(s) {
  var t = s && s.thumbnail;
  if (!t) return null;
  if (typeof t === 'string') return t;
  return pickSrcsetUrl(t.srcset, CARD_IMG_W) || t.src || t.url || null;
}
function openBrowse(categorySlug, categoryName) {
  if (!state.ready) return;
  cancelBrowseFill();
  browse.open = true;
  showCursor();
  closeSidebar();
  pausePlaybackForBrowse();
  document.getElementById('browse').className = '';
  loadBrowseLangPref();
  browse.langMenuOpen = false;      // never reopen straight into the dropdown
  renderBrowseLangBtn();
  renderBrowseLangMenu();
  // Reopened within the memory window: the directory pool we already hold is good
  // enough, so skip the skeletons and the refetch and put the grid back as it was.
  // Counts and live/offline state can be up to BROWSE_MEMORY_MS stale — that is the
  // trade. An explicit category runs its own deeper page chain, so it always loads
  // fresh rather than being refiltered out of this pool.
  if (!categorySlug && browse.raw.length && (Date.now() - browse.closedAt) < BROWSE_MEMORY_MS) {
    browse.session++;            // orphan anything still in flight from the last opening
    browse.fetching = false;     // ...and clear the flag it guards, or Browse never loads again
    browse.zone = 'grid';
    renderBrowseSort();
    renderBrowseDiscover();
    renderBrowseHideBlocked();
    updateBrowseTitle();
    renderPinnedCatChips();
    renderBrowse();              // ends in applyBrowseFocus, which scrolls the focused card in
    var g = document.getElementById('browse-grid');
    if (g) g.scrollTop = browse.scrollTop;   // ...so restore the exact position after it
    return;
  }
  browse.zone = 'grid'; browse.gridIdx = 0;
  // optionally open pre-filtered (the clickable category in the top bar)
  browse.cats = categorySlug ? [{ slug: categorySlug, name: categoryName || categorySlug }] : [];
  browse.session++;               // orphan any request still in flight from a previous opening
  browse.raw = [];
  browse.streams = []; browse.page = 1; browse.hasMore = true; browse.fetching = false;
  browse.renderLimit = 60; browse.error = false; browse.capped = false;
  getBrowseGrid().clear();
  browse.sort = 'viewers';
  browse.discover = loadBrowseDiscoverPref();
  browse.hideBlocked = loadBrowseHideBlockedPref();
  renderBrowseSort();
  renderBrowseDiscover();
  renderBrowseHideBlocked();
  renderPinnedCatChips();
  renderBrowseSkeletons();
  updateBrowseTitle();
  loadBrowseMore();
}
// The title stays "Live now" — the highlighted Categories button and the
// selected chip already show which filter is active.
function updateBrowseTitle() {
  var btn = document.getElementById('browse-cats-btn');
  if (btn) btn.className = browse.cats.length ? 'on' : '';
}
function closeBrowse() {
  browse.open = false;
  cancelBrowseFill();
  browse.session++;
  browse.fetching = false;
  closeBrowseLangMenu();
  // Remember where we were. The pool stays in memory; openBrowse decides whether
  // it is still fresh enough to reuse.
  var grid = document.getElementById('browse-grid');
  browse.scrollTop = grid ? grid.scrollTop : 0;
  browse.closedAt = Date.now();
  document.getElementById('browse').className = 'hidden';
  clearTimeout(browsePeekTimer);
  if (typeof flushChatRender === 'function') flushChatRender();
  resumePlaybackAfterBrowse();
}
function cancelBrowseFill() {
  clearTimeout(browse.fillTimer);
  clearTimeout(browse.retryTimer);
  browse.fillTimer = null;
  browse.retryTimer = null;
  browse.retryCount = 0;
}
// Count complete rows of real cards, excluding a partial row and the loader.
// The first card of the last two full rows must be entirely below the viewport.
function browseNeedsMoreRows() {
  var view = getBrowseGrid();
  var m = view.metrics;
  if (!m) return true;
  return Math.ceil(browse.streams.length / BROWSE_COLS) * m.pitchY < view.container.scrollTop + m.height + 2 * m.pitchY;
}
function scheduleBrowseFill() {
  if (!browse.open || cats.open || browse.fillTimer !== null || browse.error || !browse.hasMore) return;
  var ses = browse.session;
  browse.fillTimer = setTimeout(function () {
    browse.fillTimer = null;
    if (browse.open && !cats.open && ses === browse.session && browseNeedsMoreRows()) loadBrowseMore();
  }, 0);
}
// The loading card counts as one focusable (but inert) cell at the end, so
// Down can reach it and the grid scrolls to reveal it.
function browseFocusCount() { return browse.streams.length + (browse.error || browse.fetching || !browse.hasMore ? 1 : 0); }
function renderBrowseStatus() {
  setBrowseStatus('');
}
// One serialized request at a time, until two spare rows or the directory's end.
function loadBrowseMore() {
  if (!browse.open || cats.open || browse.fetching || !browse.hasMore) return;
  browse.fetching = true; browse.error = false;
  if (browse.raw.length) renderBrowse(true); else setBrowseStatus('Loading live streams...');
  var pg = browse.page, ses = browse.session;
  serviceGet('/stream/livestreams/en?page=' + pg + '&limit=50&sort=desc', function (err, data) {
    if (ses !== browse.session || !browse.open) return;
    browse.fetching = false;
    if (err || !data || !Array.isArray(data.data)) {
      browse.error = true; renderBrowse(true); return;
    }
    // Slugs already in the pool, kept alongside it instead of rebuilt per page.
    if (browse.rawSeenFor !== browse.raw || browse.rawSeenCount !== browse.raw.length) {
      browse.rawSeen = Object.create(null);
      for (var j = 0; j < browse.raw.length; j++) browse.rawSeen['$' + catalogueKey(browse.raw[j])] = true;
    }
    var arr = data.data, seen = browse.rawSeen, added = 0;
    for (var i = 0; i < arr.length && browse.raw.length < CATALOGUE_LIMIT; i++) {
      var it = arr[i], ch = it.channel || {}, cat = (it.categories && it.categories[0]) || null;
      var slug = ch.slug || it.slug || '';
      if (!slug || seen['$' + slug]) continue;
      seen['$' + slug] = true; added++;
      var entry = { viewer_count: it.viewer_count || 0, language: it.language || '',
        session_title: it.session_title || '', created_at: it.created_at || '', thumbnail: it.thumbnail || null,
        categories: cat ? [{ name: cat.name || '', slug: cat.slug || '' }] : [],
        channel: { slug: slug, user: { username: (ch.user && ch.user.username) || '' } } };
      entry.__bot = looksBotStream(entry);          // decided once here, not on every render
      browse.raw.push(entry);
    }
    browse.rawSeenFor = browse.raw; browse.rawSeenCount = browse.raw.length;
    browse.page = pg + 1;
    browse.capped = browse.raw.length >= CATALOGUE_LIMIT;
    browse.hasMore = !!arr.length && !!added && !browse.capped;
    renderBrowse(true);
    scheduleBrowseFill();
  }, { priority: 1 });
}
/* Languages live behind one button in the top-right corner rather than eight
   chips across the header: the row was 1152px wide and left nothing for anything
   else. The button carries the count, the dropdown carries the checkboxes. */
function renderBrowseLangBtn() {
  var el = document.getElementById('browse-langbtn');
  if (!el) return;
  var n = browse.langs.length;
  var labels = [];
  for (var i = 0; i < n; i++) {
    var label = browse.langs[i];
    for (var j = 1; j < BROWSE_LANGS.length; j++) {
      if (BROWSE_LANGS[j].value === browse.langs[i]) { label = BROWSE_LANGS[j].label; break; }
    }
    labels.push(label);
  }
  el.textContent = n ? labels[0] + (n > 1 ? ' +' + (n - 1) : '') : 'All languages';
  el.title = n ? 'Languages: ' + labels.join(', ') : 'Filter by language';
  el.className = (n ? 'on' : '') +
                 (browse.zone === 'lang' && !browse.langMenuOpen ? ' focused' : '');
}
function renderBrowseLangMenu() {
  var box = document.getElementById('browse-langmenu');
  if (!box) return;
  box.className = browse.langMenuOpen ? '' : 'hidden';
  if (!browse.langMenuOpen) return;
  for (var i = 0; i < BROWSE_LANGS.length; i++) {
    var l = BROWSE_LANGS[i], on = i === 0 ? !browse.langs.length : browse.langs.indexOf(l.value) !== -1;
    var row = box.children[i];
    if (!row) {
      row = document.createElement('div'); row.setAttribute('data-idx', i);
      var cb = document.createElement('span'); cb.className = 'blangbox'; row.appendChild(cb);
      row.appendChild(document.createTextNode(i === 0 ? 'All languages' : l.label)); box.appendChild(row);
    }
    var cls = 'blangrow' + (on ? ' on' : '') + (i === browse.langIdx ? ' focused' : '');
    if (row.className !== cls) row.className = cls;
    var tick = on ? '✓' : ''; if (row.firstChild.textContent !== tick) row.firstChild.textContent = tick;
  }
}
function openBrowseLangMenu() {
  browse.langMenuOpen = true;
  browse.zone = 'lang'; browse.headerIdx = 3;
  if (!(browse.langIdx >= 0 && browse.langIdx < BROWSE_LANGS.length)) browse.langIdx = 0;
  renderBrowseLangMenu();
  renderBrowseLangBtn();
}
function closeBrowseLangMenu() {
  if (!browse.langMenuOpen) return;
  browse.langMenuOpen = false;
  renderBrowseLangMenu();
  renderBrowseLangBtn();
}
function toggleBrowseLangMenu() {
  if (browse.langMenuOpen) closeBrowseLangMenu(); else openBrowseLangMenu();
}
/* View-botted fake streams. They come in waves under one category with random
   channel names and random titles, and inflated viewer counts that put them
   above real streamers. Measured against 960 live streams: matching on the title
   alone gives one false positive (a bare URL) and on the name alone ninety-seven
   (Cristorata7, Ac7ionMan and friends), so both must look generated at once.
   A real title nearly always contains a space; a real name rarely mixes digits
   through letters. Requiring mixed case in the title as well took the measured
   false positives to zero while still catching every bot in the sample. */
function botNameish(s) {
  s = String(s || '').trim();
  if (!s || s.indexOf(' ') !== -1 || s.length < 8) return false;
  return /[0-9]/.test(s) && /[a-z]/i.test(s);
}
function botTitleish(s) {
  s = String(s || '').trim();
  if (!s || s.indexOf(' ') !== -1 || s.length < 10) return false;
  if (/^https?:/i.test(s)) return false;          // a bare link is not keyboard mash
  return /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}
function looksBotStream(s) {
  if (!s) return false;
  var ch = s.channel || {};
  var name = (ch.user && ch.user.username) || ch.slug || '';
  return botTitleish(s.session_title) && botNameish(name);
}
function isBotStream(s) {
  if (!s) return false;
  if (s.__bot === undefined) s.__bot = looksBotStream(s);
  return s.__bot;
}
function makeBrowseCard(s, i, favs) {
  var ch = s.channel || {}, user = ch.user || {};
  var card = document.createElement('div');
  card.className = 'bcard';
  card.setAttribute('data-idx', i);
  var url = thumbUrl(s);
  var thumb = document.createElement('div');
  thumb.className = 'bthumb';
  catalogueImage(thumb, url, user.username || ch.slug || 'Live stream');
  var v = document.createElement('span');
  v.className = 'bviewers';
  v.innerHTML = '<span class="bdot"></span>';
  v.appendChild(document.createTextNode(fmtViewers(s.viewer_count || 0)));
  thumb.appendChild(v);
  var already = isFavorite(ch.slug);
  var add = document.createElement('span');
  add.className = 'baddbtn' + (already ? ' added' : '');
  add.setAttribute('data-act', 'badd');
  add.setAttribute('data-slug', ch.slug || s.slug);
  add.textContent = already ? '✓' : '+';
  card.appendChild(thumb);
  var meta = document.createElement('div');
  meta.className = 'bmeta';
  meta.innerHTML = '<div class="bname"></div><div class="btitle"></div><div class="bsub"></div>';
  meta.children[0].textContent = user.username || ch.slug || s.slug;
  meta.children[1].textContent = s.session_title || '';
  meta.children[2].textContent =
    ((s.categories && s.categories[0] && s.categories[0].name) || '') +
    (s.language ? '  ·  ' + s.language : '');
  card.appendChild(meta);
  card.appendChild(add);
  return card;
}
/* Selected categories. An array rather than a single slug so Browse can hold
   several at once; pick order is preserved so the status line reads the way you
   built it. hasBrowseCat is asked once per stream per render, but the list is a
   handful of entries, so a linear scan beats maintaining a map. */
function hasBrowseCat(slug) {
  if (!slug) return false;
  for (var i = 0; i < browse.cats.length; i++) if (browse.cats[i].slug === slug) return true;
  return false;
}
function browseCatLabel() {
  var out = [];
  for (var i = 0; i < browse.cats.length; i++) out.push(browse.cats[i].name || browse.cats[i].slug);
  return out.join(' / ');
}
// Everything that has to catch up once the selection changes. The Categories
// popup stays open while you pick, so its ticks re-render too.
function afterBrowseCatChange() {
  updateBrowseTitle();
  refilterBrowse();              // also re-counts the chips
  if (cats.open) renderCats();
}
function toggleBrowseCat(slug, name) {
  if (!slug) return;
  var out = [], found = false;
  for (var i = 0; i < browse.cats.length; i++) {
    if (browse.cats[i].slug === slug) found = true;
    else out.push(browse.cats[i]);
  }
  if (!found) out.push({ slug: slug, name: name || slug });
  browse.cats = out;
  afterBrowseCatChange();
}
function clearBrowseCats() {
  if (!browse.cats.length) return;
  browse.cats = [];
  afterBrowseCatChange();
}
// A filter changed: if the focused stream is filtered away, start over at the
// top instead of keeping a numeric index into an unrelated list.
function refilterBrowse() { renderBrowse(false, true); }
// Filtering and sorting up to 2000 streams is the expensive part of a render, and
// most renders (the loading card appearing, a focus refresh) change neither the
// pool nor the filters. The result is kept until one of them does.
function browseFilterKey() {
  return [(browse.raw || []).length, settings.hideBots ? 1 : 0, browse.langs.join(','),
          browse.discover ? getFavorites().join(',') : '', JSON.stringify(browse.cats),
          browse.hideBlocked ? JSON.stringify(getBlockedCats()) : '', browse.sort].join('|');
}
var browseFilterMemo = { key: null, raw: null, list: null };
function renderBrowse(preserveScroll, filterChanged) {
  var onStatus = browse.gridIdx >= browse.streams.length;   // the loading/retry/end card
  var old = onStatus ? null : browse.streams[browse.gridIdx];
  var identity = old ? catalogueKey(old) : null;
  var fkey = browseFilterKey();
  if (browseFilterMemo.key === fkey && browseFilterMemo.raw === browse.raw && browseFilterMemo.list) {
    finishRenderBrowse(browseFilterMemo.list.slice(), preserveScroll, filterChanged, onStatus, identity);
    return;
  }
  var list = (browse.raw || []).slice();
  if (settings.hideBots) list = list.filter(function (s) { return !isBotStream(s); });
  if (browse.langs.length) list = list.filter(function (s) { return browse.langs.indexOf(s.language) !== -1; });
  if (browse.discover) {
    list = list.filter(function (s) { return !isFavorite((s.channel || {}).slug); });
  }
  // An explicit selection of any size beats Hide Blocked: asking for a category
  // by name — including a blocked one you pinned — has to show it, or the grid
  // comes back empty and the chip looks broken. getBlockedCats() is memoized, so
  // an empty block list makes the other branch a cheap walk.
  if (browse.cats.length) {
    list = list.filter(function (s) {
      var c0 = s.categories && s.categories[0];
      return !!(c0 && hasBrowseCat(c0.slug));
    });
  } else if (browse.hideBlocked) {
    list = list.filter(function (s) {
      var c0 = s.categories && s.categories[0];
      return !(c0 && isCatBlocked(c0.slug));
    });
  }
  if (browse.sort === 'small') {
    list.sort(function (a, b) { return (a.viewer_count || 0) - (b.viewer_count || 0); });
  } else if (browse.sort === 'newest') {
    for (var pi = 0; pi < list.length; pi++) {
      if (list[pi].__startTs === undefined) list[pi].__startTs = parseKickTime(list[pi].created_at);
    }
    list.sort(function (a, b) { return (b.__startTs || 0) - (a.__startTs || 0); });
  } else {
    list.sort(function (a, b) { return (b.viewer_count || 0) - (a.viewer_count || 0); });
  }
  browseFilterMemo = { key: fkey, raw: browse.raw, list: list.slice() };
  finishRenderBrowse(list, preserveScroll, filterChanged, onStatus, identity);
}
function finishRenderBrowse(list, preserveScroll, filterChanged, onStatus, identity) {
  var prevIdx = browse.gridIdx;
  browse.streams = list;
  var found = -1;
  if (identity !== null) for (var fi = 0; fi < list.length; fi++) if (catalogueKey(list[fi]) === identity) { found = fi; break; }
  var hasStatus = !!(browse.error || browse.fetching || !browse.hasMore);
  if (found !== -1) browse.gridIdx = found;
  else if (filterChanged) browse.gridIdx = 0;
  // Focus sat on the loading/retry card: keep it there (or on the first new card
  // that took its place) rather than snapping back onto the last stream.
  else if (onStatus) browse.gridIdx = Math.max(0, Math.min(prevIdx, list.length + (hasStatus ? 0 : -1)));
  else browse.gridIdx = Math.max(0, Math.min(list.length - 1, prevIdx || 0));
  var view = getBrowseGrid(), savedScroll = view.container.scrollTop;
  if (filterChanged && found === -1) { savedScroll = 0; view.container.scrollTop = 0; }
  if (preserveScroll && identity !== null) savedScroll = catalogueAnchoredScroll(view, browse.gridIdx, identity, savedScroll);
  var favs = getFavorites(), items = list.slice();
  if (browse.error) items.push(catalogueTerminal('browse', 'Could not load more streams', true));
  else if (browse.fetching) items.push(catalogueTerminal('browse', 'Loading more streams...'));
  else if (!browse.hasMore) items.push(catalogueTerminal('browse', browse.capped ? 'Directory limit reached · Refine your filters' : (list.length ? 'End of live directory' : 'No matching streams in this directory')));
  function create(item, i) { return item.catalogueTerminal ? makeCatalogueTerminal(item) : makeBrowseCard(item, i, favs); }
  function signature(item) { return JSON.stringify(item) + (item.catalogueTerminal ? '' : '|' + isFavorite(catalogueKey(item))); }
  view.setItems(items, function (item) { return item.catalogueTerminal ? '__state' : catalogueKey(item); }, function (item, i) {
    var node = create(item, i); node.__signature = signature(item); return node;
  }, function (node, item, i) {
    var sig = signature(item); if (node.__signature !== sig) { catalogueUpdate(node, create(item, i)); node.__signature = sig; }
  });
  renderBrowseStatus();
  renderPinnedCatChips();
  applyBrowseFocus(!!preserveScroll);
  if (preserveScroll) { view.container.scrollTop = savedScroll; view.refresh(); }
}

var browseFocusEl = null;
// the loading card is focusable but not activatable, so it keeps its own base class
function browseCardBaseOf(card) { return card.getAttribute('data-base') || 'bcard'; }
function applyBrowseFocus(preserveScroll) {
  renderBrowseLangBtn();
  for (var hi = 0; hi < BROWSE_HEADERS.length; hi++) {
    var h = document.getElementById(BROWSE_HEADERS[hi]);
    if (h) h.classList.toggle('focused', (browse.zone === 'header' || browse.zone === 'lang') && hi === browse.headerIdx && !browse.langMenuOpen);
  }
  var pins = document.getElementById('browse-pinnedcats'), chip = null;
  for (var pi = 0; pins && pi < pins.children.length; pi++) {
    pins.children[pi].classList.toggle('focused', browse.zone === 'pins' && pi === browse.pinIdx);
    if (pi === browse.pinIdx) chip = pins.children[pi];
  }
  if (browse.zone === 'pins' && chip) {
    if (chip.offsetLeft < pins.scrollLeft) pins.scrollLeft = chip.offsetLeft;
    else if (chip.offsetLeft + chip.offsetWidth > pins.scrollLeft + pins.clientWidth) pins.scrollLeft = chip.offsetLeft + chip.offsetWidth - pins.clientWidth;
  }
  var view = getBrowseGrid();
  view.focused = browse.gridIdx;
  var card = browse.zone === 'grid' && !preserveScroll ? view.focus(browse.gridIdx) : view.get(browse.gridIdx);
  browseFocusEl = swapFocus(view.content, browseFocusEl, card, browseCardBaseOf, browse.zone === 'grid');
  scheduleBrowsePeek(); scheduleBrowseFill();
}
// After dwelling on a browse card, refresh its thumbnail with the channel's
// current frame (the directory image can be minutes old).
var browsePeekTimer = null;
function scheduleBrowsePeek() {
  clearTimeout(browsePeekTimer);
  if (!browse.open || cats.open || browse.zone !== 'grid') return;
  var idx = browse.gridIdx, ses = browse.session;
  var s = browse.streams[idx];
  var slug = s && s.channel && s.channel.slug;
  if (!slug) return;
  browsePeekTimer = setTimeout(function () {
    if (!browse.open || cats.open || browse.session !== ses || browse.gridIdx !== idx || !browse.streams[idx] || catalogueKey(browse.streams[idx]) !== slug) return;
    function apply(url) {
      if (!browse.open || cats.open || browse.session !== ses || browse.gridIdx !== idx || !browse.streams[idx] || catalogueKey(browse.streams[idx]) !== slug) return;
      var card = getBrowseGrid().get(idx);
      var th = card && card.querySelector('.bthumb');
      if (th) catalogueImage(th, url, slug);
    }
    var cached = previewCache[slug];
    if (cached && Date.now() - cached.t < PREVIEW_REFRESH_MS) { apply(cached.url); return; }
    fetchPreviewUrl(slug, function () {
      var c2 = previewCache[slug];
      if (c2) apply(c2.url);
    }, true);
  }, 800);
}
// Toggle a language chip in or out of the selection. The All chip (index 0)
// clears the selection. Multiple languages can be active at once.
function toggleBrowseLang(idx) {
  browse.langIdx = idx;
  if (idx === 0) browse.langs = [];
  else {
    var v = BROWSE_LANGS[idx].value;
    var i = browse.langs.indexOf(v);
    if (i === -1) browse.langs.push(v); else browse.langs.splice(i, 1);
  }
  saveBrowseLangPref();
  renderBrowseLangBtn();
  renderBrowseLangMenu();    // the menu stays open so several can be picked at once
  refilterBrowse();          // just re-filter what we already fetched
}
function browseMove(dx, dy) {
  if (browse.langMenuOpen) {
    if (dy) { var ln = browse.langIdx + dy; if (ln >= 0 && ln < BROWSE_LANGS.length) { browse.langIdx = ln; renderBrowseLangMenu(); } }
    return;
  }
  var pins = document.getElementById('browse-pinnedcats');
  var hasPins = pins && pins.children.length && pins.className !== 'hidden';
  if (browse.zone === 'lang') { browse.zone = 'header'; browse.headerIdx = 3; }
  if (browse.zone === 'header') {
    if (dx) browse.headerIdx = Math.max(0, Math.min(BROWSE_HEADERS.length - 1, browse.headerIdx + dx));
    if (dy > 0) browse.zone = hasPins ? 'pins' : 'grid';
  } else if (browse.zone === 'pins') {
    if (dx) browse.pinIdx = Math.max(0, Math.min(pins.children.length - 1, browse.pinIdx + dx));
    if (dy < 0) browse.zone = 'header';
    if (dy > 0) browse.zone = 'grid';
  } else if (dy < 0 && browse.gridIdx < BROWSE_COLS) browse.zone = hasPins ? 'pins' : 'header';
  else browse.gridIdx = catalogueMove(browse.gridIdx, browseFocusCount(), BROWSE_COLS, dx, dy);
  applyBrowseFocus();
}
function browseActivate() {
  if (browse.langMenuOpen) { toggleBrowseLang(browse.langIdx); return; }
  if (browse.zone === 'lang') { openBrowseLangMenu(); return; }
  if (browse.zone === 'header') {
    var actions = [openCats, toggleBrowseDiscover, toggleBrowseHideBlocked, openBrowseLangMenu, closeBrowse];
    actions[browse.headerIdx](); return;
  }
  if (browse.zone === 'pins') {
    var pins = getPinnedCats(), pin = pins[browse.pinIdx - 1];
    if (!browse.pinIdx) clearBrowseCats(); else if (pin) toggleBrowseCat(pin.slug, pin.name);
    applyBrowseFocus(true); return;
  }
  if (browse.gridIdx >= browse.streams.length) { if (browse.error) loadBrowseMore(); return; }
  var s = browse.streams[browse.gridIdx];
  if (!s) return;
  var slug = (s.channel && s.channel.slug) || s.slug;
  if (slug) { closeBrowse(); play(slug); }
}
// The "+" on a browse card saves that streamer without leaving the popup.
function browseAddFavorite(slug) {
  if (!slug || isFavorite(slug)) return;
  addFavorite(slug);
  if (slug === state.tempChannel) state.tempChannel = null;   // it is a real favorite now
  state.lastFetch = 0;                                        // let the sidebar refresh next time
  apiGet(slug, function (err, raw) { if (!err) state.channels[slug] = normalize(slug, raw); });
  toast('Added ' + slug);
  renderBrowse();          // flip the card's + into a check
}

