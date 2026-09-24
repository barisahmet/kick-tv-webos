'use strict';
/* Categories popup. Browse Kick's categories (sorted by viewers) and filter the
   live grid to one. Kick has no per-category live-streams endpoint, so the filter
   is applied over the streams already pulled into Browse: great for popular
   categories, thinner for niche ones. Opened from the Browse header. */
var cats = { open: false, gridIdx: 0, list: [], page: 1, hasMore: true, fetching: false, session: 0,
             query: '', results: null, error: false, searchError: false, searching: false, capped: false, closedAt: 0, scrollTop: 0, focusKey: null, zone: 'grid', headerIdx: 0 };
var CATS_LIMIT = 1024;
function catKey(c) { return c.catalogueTerminal ? '__state' : (c.all ? '__all' : c.slug); }
function getCatsGrid() {
  if (!catsGridView) catsGridView = new VirtualGrid(document.getElementById('cats-grid'), { columns: CATS_COLS, height: 233, onRender: function () {
    catsFocusEl = catalogueMountedFocus(catsGridView, cats.gridIdx, cats.zone === 'grid', catsCardBaseOf);
  } });
  return catsGridView;
}
function compactCat(c) { return { slug: c.slug || '', name: c.name || c.slug || '', viewers: c.viewers || 0, banner: c.banner || null }; }
function mergeCats(arr, replaceFirst) {
  var seen = {}, out = [], first = replaceFirst ? arr : cats.list, second = replaceFirst ? cats.list : arr;
  for (var pass = 0; pass < 2; pass++) {
    var list = pass ? second : first;
    for (var i = 0; i < list.length && out.length < CATS_LIMIT; i++) if (list[i].slug && !seen['$' + list[i].slug]) {
      seen['$' + list[i].slug] = true; out.push(compactCat(list[i]));
    }
  }
  cats.list = out; cats.capped = out.length >= CATS_LIMIT;
}
// The grid shows either the paginated list or, while searching, the API's
// category search results (identical item shape).
function displayedCats() { return cats.results || cats.list; }
var CATS_COLS = 4;
function setCatsStatus(msg) { document.getElementById('cats-status').textContent = msg || ''; }
function catBanner(c) {
  var b = c && c.banner;
  if (!b) return null;
  if (typeof b === 'string') return b;
  // `responsive` offers 294w up to 600w; the tile is 376px. Never fall through to
  // the raw `responsive` string — that is a srcset, not a URL.
  return pickSrcsetUrl(b.responsive, CARD_IMG_W) || b.url || b.src || null;
}
function openCats() {
  if (!browse.open) return;
  var warm = cats.list.length && Date.now() - (cats.loadedAt || cats.closedAt) < 300000;
  cats.open = true; cats.session++; cats.fetching = false; cats.searching = false; cats.refreshing = false;
  clearTimeout(browsePeekTimer);
  cats.zone = 'grid';
  document.getElementById('cats').className = ''; showCursor();
  if (warm) {
    var view = getCatsGrid(); view.container.scrollTop = cats.scrollTop; view.dirty = true;
    renderCats(true);
    if (cats.query) runCatsSearch(cats.query);
    else refreshCats();
    return;
  }
  cats.gridIdx = 0; cats.focusKey = null; cats.list = []; cats.page = 1; cats.hasMore = true;
  cats.error = false; cats.searchError = false; cats.capped = false; cats.query = ''; cats.results = null;
  document.getElementById('cats-search').value = '';
  getCatsGrid().clear(); renderCatsSkeletons(); setCatsStatus('Loading categories...'); loadCatsMore(true);
}
function refreshCats() {
  if (!cats.open || cats.refreshing) return;
  cats.refreshing = true; cats.error = false; cats.refreshError = false;
  renderCats(true);
  var ses = cats.session;
  serviceGet('/api/v1/subcategories?page=1&limit=32', function (err, data) {
    if (!cats.open || ses !== cats.session) return;
    cats.refreshing = false;
    if (err || !data || !Array.isArray(data.data)) { cats.error = true; cats.refreshError = true; renderCats(true); return; }
    cats.error = false; cats.refreshError = false; cats.loadedAt = Date.now(); mergeCats(data.data, true); renderCats(true);
  }, { priority: 2 });
}
function closeCats() {
  cats.open = false; cats.session++; cats.fetching = false; cats.searching = false; cats.refreshing = false;
  cats.closedAt = Date.now(); cats.scrollTop = document.getElementById('cats-grid').scrollTop;
  clearTimeout(catsSearchTimer);
  try { document.getElementById('cats-search').blur(); } catch (e) {}
  document.getElementById('cats').className = 'hidden';
  if (typeof flushChatRender === 'function') flushChatRender();
  scheduleBrowseFill();
}
// Static tiles preserve the catalogue geometry while the first page loads.
function renderCatsSkeletons() { catalogueSkeletons(getCatsGrid(), 'cats'); }
// Keep a bounded directory pool; the search endpoint can find categories beyond it.
function loadCatsMore(initial) {
  if (!cats.open || cats.fetching || !cats.hasMore || cats.query) return;
  cats.fetching = true; cats.error = false; cats.refreshError = false;
  if (cats.list.length) renderCats(true);
  var pg = cats.page, ses = cats.session;
  serviceGet('/api/v1/subcategories?page=' + pg + '&limit=32', function (err, data) {
    if (ses !== cats.session || !cats.open) return;
    cats.fetching = false;
    if (err || !data || !Array.isArray(data.data)) { cats.error = true; if (!cats.query) renderCats(true); return; }
    var arr = data.data, before = cats.list.length;
    mergeCats(arr, false); cats.loadedAt = Date.now(); cats.page = pg + 1;
    cats.hasMore = !!arr.length && cats.list.length > before && !cats.capped;
    if (!cats.query) renderCats(true);
    if (initial && cats.page <= 2 && cats.hasMore) loadCatsMore(true);
  }, { priority: 1 });
}
// Search across all of Kick's categories (the paginated list only holds what
// has been scrolled in so far).
var catsSearchTimer = null;
function runCatsSearch(q) {
  var ses = cats.session;
  cats.searching = true; cats.searchError = false;
  renderCats(true);
  serviceGet('/api/search?searched_word=' + encodeURIComponent(q), function (err, data) {
    if (ses !== cats.session || !cats.open || cats.query !== q) return;
    cats.searching = false;
    if (err || !data || !Array.isArray(data.categories)) { cats.searchError = true; renderCats(true); return; }
    cats.results = data.categories.slice(0, CATS_LIMIT).map(compactCat);
    renderCats();
  }, { priority: 1 });
}
function renderCats(preserveScroll) {
  var view = getCatsGrid(), saved = view.container.scrollTop;
  var items = [{ all: true }].concat(displayedCats());
  if (cats.query && cats.searchError) items.push(catalogueTerminal('cats', 'Could not search categories', true));
  else if (!cats.query && cats.error) items.push(catalogueTerminal('cats', 'Could not load categories', true));
  else if (cats.searching || (!cats.query && (cats.fetching || cats.refreshing))) items.push(catalogueTerminal('cats', 'Loading categories...'));
  else if (cats.query) items.push(catalogueTerminal('cats', displayedCats().length ? 'End of search results' : 'No categories match'));
  else if (!cats.hasMore) items.push(catalogueTerminal('cats', cats.capped ? 'Category limit reached · Search for more' : 'End of categories'));
  cats.gridIdx = catalogueIdentityIndex(items, catKey, cats.focusKey, cats.gridIdx);
  if (preserveScroll && cats.focusKey !== null) saved = catalogueAnchoredScroll(view, cats.gridIdx, cats.focusKey, saved);
  var flags = '|' + JSON.stringify(browse.cats) + '|' + JSON.stringify(getPinnedCats()) + '|' + JSON.stringify(getBlockedCats());
  function signature(c) { return JSON.stringify(c) + flags; }
  view.setItems(items, catKey, function (c, i) { var node = makeCatCard(c, i); node.__signature = signature(c); return node; }, function (node, c, i) {
    var sig = signature(c); if (node.__signature !== sig) { catalogueUpdate(node, makeCatCard(c, i)); node.__signature = sig; }
  });
  setCatsStatus(''); applyCatsFocus(!!preserveScroll);
  if (preserveScroll) { view.container.scrollTop = saved; view.refresh(); }
}
function makeCatCard(c, i) {
  if (c.catalogueTerminal) return makeCatalogueTerminal(c);
  var card = document.createElement('div'); card.className = 'ccard';
  var banner = document.createElement('div'); banner.className = c.all ? 'cbanner call' : 'cbanner';
  if (c.all) {
    // No artwork for "every category": a grid mark instead of an empty black tile.
    banner.innerHTML = '<svg class="callicon" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>';
  } else {
    catalogueImage(banner, catBanner(c), c.name || c.slug);
    var vw = document.createElement('span'); vw.className = 'cviewers';
    vw.innerHTML = '<span class="bdot"></span>'; vw.appendChild(document.createTextNode(fmtViewers(c.viewers || 0))); banner.appendChild(vw);
    var pin = document.createElement('span'); pin.className = 'catpin' + (isCatPinned(c.slug) ? ' on' : '');
    pin.setAttribute('data-act', 'catpin'); pin.setAttribute('title', 'Pin category'); pin.innerHTML = pinIcon(); banner.appendChild(pin);
    var block = document.createElement('span'); block.className = 'catblock' + (isCatBlocked(c.slug) ? ' on' : '');
    block.setAttribute('data-act', 'catblock'); block.setAttribute('title', 'Block category'); block.innerHTML = blockIcon(); banner.appendChild(block);
  }
  if (c.all ? !browse.cats.length : hasBrowseCat(c.slug)) {
    var tick = document.createElement('span'); tick.className = 'catsel'; tick.textContent = '✓'; banner.appendChild(tick);
  }
  var name = document.createElement('div'); name.className = 'cname'; name.textContent = c.all ? 'All categories' : (c.name || c.slug);
  card.appendChild(banner); card.appendChild(name); return card;
}
var catsFocusEl = null;
function catsCardBaseOf(card) { return card.getAttribute('data-base') || 'ccard'; }
function applyCatsFocus(preserveScroll) {
  var view = getCatsGrid(), el = cats.zone === 'grid' && !preserveScroll ? view.focus(cats.gridIdx) : view.get(cats.gridIdx);
  view.focused = cats.gridIdx;
  var item = view.items[cats.gridIdx]; cats.focusKey = item ? catKey(item) : null;
  catsFocusEl = swapFocus(view.content, catsFocusEl, el, catsCardBaseOf, cats.zone === 'grid');
  document.getElementById('cats-search').classList.toggle('focused', cats.zone === 'header' && cats.headerIdx === 0);
  document.getElementById('cats-close').classList.toggle('focused', cats.zone === 'header' && cats.headerIdx === 1);
}
function catsMove(dx, dy) {
  if (cats.zone === 'header') {
    if (dx) cats.headerIdx = Math.max(0, Math.min(1, cats.headerIdx + dx));
    if (dy > 0) { cats.zone = 'grid'; document.getElementById('cats-search').blur(); }
  } else if (dy < 0 && cats.gridIdx < CATS_COLS) cats.zone = 'header';
  else cats.gridIdx = catalogueMove(cats.gridIdx, getCatsGrid().items.length, CATS_COLS, dx, dy);
  applyCatsFocus();
  if (cats.zone === 'grid' && !cats.query && !cats.error && cats.gridIdx >= cats.list.length + 1 - 2 * CATS_COLS) loadCatsMore(false);
}
// OK toggles and the popup stays up, so several categories can be picked in one
// visit. Back is what closes it.
function catsActivate() {
  if (cats.zone === 'header') { if (cats.headerIdx) closeCats(); else document.getElementById('cats-search').focus(); return; }
  var item = getCatsGrid().items[cats.gridIdx];
  if (item && item.catalogueTerminal) {
    if (item.retry) { if (cats.query) runCatsSearch(cats.query); else if (cats.refreshError) refreshCats(); else { cats.hasMore = true; loadCatsMore(false); } }
    return;
  }
  if (cats.gridIdx === 0) { clearBrowseCats(); return; }
  var c = displayedCats()[cats.gridIdx - 1]; if (c) toggleBrowseCat(c.slug, c.name || c.slug);
}

/* Pinned categories: starred in the Categories popup (Green, or the pin icon),
   they appear as quick chips above the Browse grid. */
function getPinnedCats() {
  try {
    var v = JSON.parse(localStorage.getItem('kicktv.pinnedcats'));
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  } catch (e) { return []; }
}
function savePinnedCats(list) { try { localStorage.setItem('kicktv.pinnedcats', JSON.stringify(list)); } catch (e) {} }
function isCatPinned(slug) {
  var l = getPinnedCats();
  for (var i = 0; i < l.length; i++) if (l[i].slug === slug) return true;
  return false;
}
function toggleCatPin(slug, name) {
  if (!slug) return;
  var l = getPinnedCats(), out = [], found = false;
  for (var i = 0; i < l.length; i++) { if (l[i].slug === slug) found = true; else out.push(l[i]); }
  if (!found) { out.push({ slug: slug, name: name || slug }); while (out.length > 8) out.shift(); }
  savePinnedCats(out);
  toast(found ? ('Unpinned ' + (name || slug)) : ('Pinned ' + (name || slug)));
  renderPinnedCatChips();
  if (cats.open) renderCats();
}
var chipCountMemo = { key: null, raw: null, counts: null };   // recounted only when the pool or its filters change
function renderPinnedCatChips() {
  var box = document.getElementById('browse-pinnedcats');
  var panel = document.getElementById('browse-panel');
  if (!box) return;
  var l = getPinnedCats();
  if (!l.length) {
    box.innerHTML = ''; box.__signature = ''; box.className = 'hidden';
    if (browse.zone === 'pins') browse.zone = 'header';
    if (panel) panel.className = '';
    return;
  }
  box.className = '';
  if (panel) panel.className = 'haspins';   // the grid gives up a row of height
  // Live streams per category, counted under the SAME language and Discover
  // filters the grid uses — the number a chip shows is the number of cards
  // clicking it will yield. Re-rendered on every filter change.
  var hideFollowed = browse.discover;
  var countKey = [(browse.raw || []).length, settings.hideBots ? 1 : 0, browse.langs.join(','),
                  hideFollowed ? getFavorites().join(',') : ''].join('|');
  var counts = chipCountMemo.key === countKey && chipCountMemo.raw === browse.raw ? chipCountMemo.counts : null;
  if (!counts) {
    counts = {};
    var pool = browse.raw || [];
    for (var ri = 0; ri < pool.length; ri++) {
      var s = pool[ri];
      if (settings.hideBots && isBotStream(s)) continue;   // chips count what the grid will show
      if (browse.langs.length && browse.langs.indexOf(s.language) === -1) continue;
      if (hideFollowed && isFavorite((s.channel || {}).slug)) continue;
      var rc = s.categories && s.categories[0];
      if (rc && rc.slug) counts[rc.slug] = (counts[rc.slug] || 0) + 1;
    }
    chipCountMemo = { key: countKey, raw: browse.raw, counts: counts };
  }
  var chipSignature = JSON.stringify(l) + '|' + JSON.stringify(counts) + '|' + JSON.stringify(browse.cats);
  if (box.__signature === chipSignature) return;
  box.__signature = chipSignature;
  var savedLeft = box.scrollLeft;
  box.innerHTML = '';
  var all = document.createElement('span');
  all.className = 'pcat' + (browse.cats.length ? '' : ' sel');
  all.textContent = 'All';
  all.setAttribute('data-cslug', '');
  box.appendChild(all);
  for (var i = 0; i < l.length; i++) {
    var chip = document.createElement('span');
    chip.className = 'pcat' + (hasBrowseCat(l[i].slug) ? ' sel' : '');
    chip.setAttribute('data-cslug', l[i].slug);
    chip.setAttribute('data-cname', l[i].name);
    chip.appendChild(document.createTextNode(l[i].name + (counts[l[i].slug] ? ' · ' + counts[l[i].slug] : '')));
    var x = document.createElement('span');   // quick unpin without opening Categories
    x.className = 'pcatx';
    x.setAttribute('data-x', '1');
    x.setAttribute('title', 'Unpin');
    x.textContent = '✕';
    chip.appendChild(x);
    box.appendChild(chip);
  }
  browse.pinIdx = Math.min(browse.pinIdx, l.length);
  box.scrollLeft = savedLeft;
  if (browseGridView) { browseGridView.dirty = true; browseGridView.schedule(); }
}

/* Blocked categories. A category you would rather not see: followed channels
   streaming in one stay in your list but sink to the bottom of the live group,
   greyed out, and stop raising alerts or being picked automatically. */
var BLOCKEDCATS_KEY = 'kicktv.blockedcats';
var BLOCKEDCATS_LIMIT = 32;   // only ever shown in a scrollable popup, unlike the 8 pinned chips
// sortOrder asks this hundreds of times per pass, so the parsed list is kept
// around. saveBlockedCats is the only writer, which is the whole invalidation
// story. Callers must treat the returned array as read-only.
var blockedCatsMemo = null;
function getBlockedCats() {
  if (blockedCatsMemo) return blockedCatsMemo;
  var v = null;
  try { v = JSON.parse(localStorage.getItem(BLOCKEDCATS_KEY)); } catch (e) {}
  blockedCatsMemo = Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  return blockedCatsMemo;
}
function saveBlockedCats(list) {
  blockedCatsMemo = null;
  try { localStorage.setItem(BLOCKEDCATS_KEY, JSON.stringify(list)); } catch (e) {}
}
function isCatBlocked(slug) {
  if (!slug) return false;
  var l = getBlockedCats();
  for (var i = 0; i < l.length; i++) if (l[i].slug === slug) return true;
  return false;
}
// Only ever true for a live channel: an offline record carries an empty
// categorySlug, so blocking simply does not apply to it.
function isChannelBlocked(c) {
  return !!(c && c.live && c.categorySlug && isCatBlocked(c.categorySlug));
}
// Store only — callers handle the toast and the re-render.
function toggleCatBlock(slug, name) {
  if (!slug) return false;
  var l = getBlockedCats(), out = [], found = false, i;
  for (i = 0; i < l.length; i++) { if (l[i].slug === slug) found = true; else out.push(l[i]); }
  if (!found) {
    out.push({ slug: slug, name: name || slug });
    while (out.length > BLOCKEDCATS_LIMIT) out.shift();
  }
  saveBlockedCats(out);
  // Pinned and blocked contradict each other. Drop the pin directly rather than
  // through toggleCatPin, which would toast and re-render on its own.
  if (!found && isCatPinned(slug)) {
    var p = getPinnedCats(), keep = [];
    for (i = 0; i < p.length; i++) if (p[i].slug !== slug) keep.push(p[i]);
    savePinnedCats(keep);
  }
  return !found;
}
// Everything that has to catch up once the blocked set changes. Re-sorting is
// what moves a channel into or out of the demoted tier.
function applyBlockedChange() {
  sortOrder(state.order.slice());
  if (state.sidebarOpen) renderSidebar();
  if (chpop.open) refreshChpopList();
  renderPinnedCatChips();          // blocking may have removed a pin
  if (browse.open) renderBrowse(); // the grid hides blocked categories, so the set moved under it
  if (cats.open) renderCats();
  if (settings.open) renderSettings();
}

