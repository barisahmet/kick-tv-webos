'use strict';
/* Add channel dialog */
// The Add dialog is a search: type a name, get matching channels, pick one. It
// still handles an exact slug or a kick.com URL as a fallback when search finds
// nothing. 'input' zone = typing; 'list' zone = choosing a result.
var add = { results: [], focus: -1, zone: 'input', session: 0, suggesting: false };
function openAdd() {
  setMode('add');
  add.session++;                    // ties in-flight adds to the dialog that started them
  add.results = []; add.focus = -1; add.zone = 'input';
  document.getElementById('addresults').innerHTML = '';
  document.getElementById('addmodal').className = '';
  var input = document.getElementById('addinput');
  input.value = '';
  // Offer channels first, so most adds are a press of OK rather than a trip
  // through the on-screen keyboard. Up from the top row (or no suggestions)
  // still lands in the text box.
  if (showAddSuggestions(true)) return;
  setTimeout(function () { if (state.mode === 'add' && add.zone === 'input') input.focus(); }, 50);
}
function closeAdd() {
  document.getElementById('addmodal').className = 'hidden';
  document.getElementById('addinput').blur();
  document.getElementById('addresults').innerHTML = '';
  add.results = []; add.zone = 'input';
  setMode('player');
  // Focus the playing channel (or the top of the list) — NOT the Add row, which would
  // yank the list all the way to the bottom every time the dialog is dismissed.
  var back = (state.current && state.order.indexOf(state.current) !== -1) ? state.current
           : (state.tempChannel || state.order[0] || 'add');
  if (state.sidebarOpen) renderSidebar(back); else openSidebar();
  if (!state.current) showNothing();   // bring back the idle message we hid
  resetIdle();                         // the idle timer ran out while the dialog was up
}
// OK: add the highlighted suggestion if you moved into the list, otherwise add
// exactly what was typed (the Add button does the same).
function confirmAdd() {
  if (add.zone === 'list') { selectAddResult(); return; }
  var q = document.getElementById('addinput').value.trim();
  if (q) addChannelBySlug(q); else closeAdd();
}
// Search as you type (debounced), showing channel suggestions live.
var addSearchTimer = null;
function scheduleLiveSearch() { clearTimeout(addSearchTimer); addSearchTimer = setTimeout(liveSearch, 300); }
function liveSearch() {
  var q = document.getElementById('addinput').value.trim();
  if (q.length < 2) {
    // an emptied box brings the suggestions back rather than a blank list
    if (!q && showAddSuggestions(false)) return;
    add.suggesting = false; add.results = []; add.focus = -1; document.getElementById('addresults').innerHTML = ''; return;
  }
  serviceGet('/api/search?searched_word=' + encodeURIComponent(q), function (err, data) {
    if (state.mode !== 'add') return;
    if (document.getElementById('addinput').value.trim() !== q) return;   // a newer keystroke superseded this
    var chans = (!err && data && data.channels) ? data.channels : [];
    add.suggesting = false;
    add.results = chans.slice(0, 30);
    if (add.zone === 'input') add.focus = -1;
    else if (!add.results.length) { backToInput(); return; }        // list emptied under us
    else if (add.focus >= add.results.length) add.focus = add.results.length - 1;
    renderAddResults();
  });
}
function enterAddList() {
  if (!add.results.length) return;
  add.zone = 'list'; add.focus = 0;
  document.getElementById('addinput').blur();
  applyAddFocus();
}
function renderAddResults() {
  var box = document.getElementById('addresults');
  box.innerHTML = '';
  var favsInResults = getFavorites();   // once per render, not once per row
  add.results.forEach(function (c, i) {
    var name = (c.user && c.user.username) || c.slug;
    var already = favsInResults.indexOf(c.slug) !== -1;
    var row = document.createElement('div');
    row.setAttribute('data-base', 'aresult' + (already ? ' added' : ''));
    row.className = 'aresult' + (already ? ' added' : '');
    row.setAttribute('data-idx', i);
    var av = document.createElement('div');
    av.className = 'aav';
    av.textContent = (name || '?').charAt(0).toUpperCase();
    row.appendChild(av);
    var mid = document.createElement('div');
    mid.className = 'amid';
    mid.innerHTML = '<div class="aname"></div><div class="asub"></div>';
    mid.children[0].textContent = name;
    mid.children[1].textContent = c.__sub || (fmtViewers(c.followers_count || c.followersCount || 0) + ' followers');
    row.appendChild(mid);
    if (c.isLive || c.is_live) {
      var live = document.createElement('span'); live.className = 'alive'; live.textContent = 'LIVE';
      row.appendChild(live);
    }
    if (already) {
      var ab = document.createElement('span'); ab.className = 'aadded'; ab.textContent = '✓ Added';
      row.appendChild(ab);
    }
    box.appendChild(row);
  });
  applyAddFocus();
}
var addFocusEl = null;
// data-base carries the 'already following' state
function addRowBaseOf(row) { return row.getAttribute('data-base') || 'aresult'; }
function applyAddFocus() {
  var box = document.getElementById('addresults');
  // add.focus is -1 while the text box has focus, which clears the list highlight
  var row = add.focus >= 0 ? (box.children[add.focus] || null) : null;
  addFocusEl = swapFocus(box, addFocusEl, row, addRowBaseOf, true);
  scrollIntoViewport(box, row, 6);
}
function addNav(delta) {
  if (!add.results.length) { if (delta < 0) backToInput(); return; }
  var n = add.focus + delta;
  if (n < 0) { backToInput(); return; }   // up past the top jumps back to the box
  if (n >= add.results.length) return;
  add.focus = n; applyAddFocus();
}
function backToInput() {
  clearTimeout(addSuggestTimer);
  add.zone = 'input'; add.focus = -1;
  applyAddFocus();                 // keep the suggestions, just drop the highlight
  var input = document.getElementById('addinput');
  setTimeout(function () { input.focus(); }, 30);
}
function selectAddResult() {
  var c = add.results[add.focus];
  if (c) addChannelBySlug(c.slug);
}
/* Add suggestions: channels you watched without following (newest first), then
   the biggest live channels in your Browse languages, minus bot streams, blocked
   categories and anything you already follow. */
var RECENT_KEY = 'kicktv.recent', RECENT_MAX = 12, RECENT_SHOWN = 5, LIVE_SUGGEST_MAX = 10;
var LIVE_SUGGEST_TTL = 120000, LIVE_SUGGEST_PAGES = 4;
var liveSuggest = { list: null, at: 0, pending: false };
var addSuggestTimer = null;
function rememberRecent(slug) {
  if (!slug) return;
  var list = lsGet(RECENT_KEY).filter(function (r) { return r && r.slug && r.slug !== slug; });
  list.unshift({ slug: slug, t: Date.now() });
  lsSet(RECENT_KEY, list.slice(0, RECENT_MAX));
}
function recentSuggestions() {
  var out = [];
  lsGet(RECENT_KEY).forEach(function (r) {
    if (out.length >= RECENT_SHOWN || !r || !r.slug || isFavorite(r.slug)) return;
    var ch = state.channels[r.slug];
    out.push({ slug: r.slug, user: { username: (ch && ch.name) || r.slug }, is_live: !!(ch && ch.live),
               __sub: 'Watched ' + fmtVodAgo(new Date(r.t).toISOString().replace('T', ' ').slice(0, 19)) });
  });
  return out;
}
// Kick's directory has no language filter, so a language like Turkish may need a
// few pages of the top streams; whatever Browse already loaded counts too.
function liveSuggestions(skip) {
  var out = [], seen = Object.create(null);
  (liveSuggest.list || []).concat(browse.raw || []).forEach(function (e) {
    var slug = e.channel && e.channel.slug;
    if (!slug || seen[slug] || out.length >= LIVE_SUGGEST_MAX || skip[slug] || isFavorite(slug)) return;
    seen[slug] = true;
    if (settings.hideBots && e.__bot) return;
    var cat = e.categories[0];
    if (cat && isCatBlocked(cat.slug)) return;
    if (browse.langs.length && browse.langs.indexOf(e.language) === -1) return;
    out.push({ slug: slug, user: { username: e.channel.user.username || slug }, is_live: true,
               __sub: fmtViewers(e.viewer_count) + ' watching' + (cat && cat.name ? ' \u00b7 ' + cat.name : '') });
  });
  return out;
}
function addSuggestionList() {
  var list = recentSuggestions(), skip = Object.create(null);
  list.forEach(function (c) { skip[c.slug] = true; });
  return list.concat(liveSuggestions(skip));
}
// Fill the list with suggestions. On open (first) the top row takes the focus;
// later (the box was cleared) the text box keeps it. False when there is nothing
// to offer yet and no fetch that could bring something.
function showAddSuggestions(first) {
  if (!browse.langs.length) loadBrowseLangPref();
  add.suggesting = true;
  add.results = addSuggestionList();
  var stale = !liveSuggest.list || Date.now() - liveSuggest.at > LIVE_SUGGEST_TTL;
  if (stale) fetchLiveSuggestions(add.session);
  if (!add.results.length && !stale) { add.suggesting = false; return false; }
  if (first) { add.zone = 'list'; add.focus = add.results.length ? 0 : -1; }
  renderAddResults();
  if (!add.results.length) {
    var box = document.getElementById('addresults');
    box.innerHTML = '<div class="astatus">Finding live channels...</div>';
    // a slow answer should not leave the remote with nothing to do
    clearTimeout(addSuggestTimer);
    if (first) addSuggestTimer = setTimeout(function () {
      if (state.mode === 'add' && add.suggesting && !add.results.length) backToInput();
    }, 4000);
  }
  return true;
}
function fetchLiveSuggestions(ses) {
  if (liveSuggest.pending) return;
  liveSuggest.pending = true;
  var list = [], page = 1;
  function toEntry(it) {
    var ch = it.channel || {}, cat = (it.categories && it.categories[0]) || null;
    var e = { viewer_count: it.viewer_count || 0, language: it.language || '',
      session_title: it.session_title || '', categories: cat ? [{ name: cat.name || '', slug: cat.slug || '' }] : [],
      channel: { slug: ch.slug || it.slug || '', user: { username: (ch.user && ch.user.username) || '' } } };
    e.__bot = looksBotStream(e);
    return e;
  }
  function next() {
    serviceGet('/stream/livestreams/en?page=' + page + '&limit=50&sort=desc', function (err, data) {
      var arr = (!err && data && Array.isArray(data.data)) ? data.data : null;
      if (arr) {
        list = list.concat(arr.map(toEntry).filter(function (e) { return e.channel.slug; }));
        liveSuggest.list = list; liveSuggest.at = Date.now();
      }
      var enough = liveSuggestions(Object.create(null)).length >= LIVE_SUGGEST_MAX;
      if (arr && arr.length && !enough && page < LIVE_SUGGEST_PAGES) { page++; refreshAddSuggestions(ses, false); next(); return; }
      liveSuggest.pending = false;
      refreshAddSuggestions(ses, true);
    }, { priority: 1 });
  }
  next();
}
// Only touch a dialog that is still this one and still showing suggestions.
function refreshAddSuggestions(ses, final) {
  if (state.mode !== 'add' || add.session !== ses || !add.suggesting) return;
  if (document.getElementById('addinput').value.trim()) return;
  var hadNone = !add.results.length;
  add.results = addSuggestionList();
  if (!add.results.length) {
    if (!final) return;                     // more pages are on the way
    document.getElementById('addresults').innerHTML = '';
    if (add.zone === 'list') backToInput();
    return;
  }
  if (hadNone && add.zone === 'list') { clearTimeout(addSuggestTimer); add.focus = 0; }
  else if (add.focus >= add.results.length) add.focus = add.results.length - 1;
  renderAddResults();
}
function addChannelBySlug(raw) {
  var slug = (raw || '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?kick\.com\//, '').replace(/[\/?#].*$/, '');
  if (!slug) return;
  if (isFavorite(slug)) {                          // already following — don't add it again
    toast(((state.channels[slug] && state.channels[slug].name) || slug) + ' is already in your channels');
    return;
  }
  toast('Adding ' + slug + '...');
  var ses = add.session;
  apiGet(slug, function (err, data) {
    if (err) { toast(err === 404 ? 'No channel named "' + slug + '"' : 'Kick API unreachable'); return; }
    state.channels[slug] = normalize(slug, data);
    addFavorite(slug);
    toast('Added ' + state.channels[slug].name);
    var wasAdd = state.mode === 'add' && add.session === ses;   // never touch a newer dialog
    if (wasAdd) {                         // only touch the dialog if it is still the one on screen
      document.getElementById('addmodal').className = 'hidden';
      document.getElementById('addinput').blur();
      document.getElementById('addresults').innerHTML = '';
      add.results = []; add.zone = 'input';
      setMode('player');
    }
    fetchFavorites(function () {
      if (wasAdd && !state.sidebarOpen) openSidebar(); else if (state.sidebarOpen) renderSidebar(slug);
      if (!state.current && !state.vod && state.mode === 'player') showNothing();
    });
  });
}

