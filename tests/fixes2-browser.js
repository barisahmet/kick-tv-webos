/* Regression checks for the whole-code review before v1.6.2. Synthetic fixtures only. */
window.runFixes2Tests = async function (assert) {
  var video = document.getElementById('video');
  var real = { serviceGet: serviceGet, apiGet: apiGet, fetchFavorites: fetchFavorites, resetIdle: resetIdle };
  function notifyText() { return document.getElementById('notify').textContent; }
  function alertFor(slug) {
    return (state.notifyCurrent && state.notifyCurrent.slug === slug) || state.notifyQueue.some(function (i) { return i.slug === slug; });
  }
  function clearAlerts() { state.notifyQueue = []; if (state.notifyCurrent) finishNotify(); state.notifyQueue = []; }
  try {
    // A lookup that failed says nothing about whether a channel is live.
    settings.alerts = 'all'; clearAlerts();
    state.baselineSet = false; state.wasLive = {};
    state.channels.beta.live = false;                    // what an unanswered lookup leaves behind: old or placeholder data
    detectOnline(['alpha', 'beta'], { beta: true });
    assert(state.wasLive.beta === undefined && state.wasLive.alpha === true, 'a failed lookup records nothing about that channel');
    state.channels.beta.live = true;
    detectOnline(['alpha', 'beta']);
    assert(!alertFor('beta'), 'so its first real answer is a baseline, not a "came online" alert');
    state.channels.beta.live = false; detectOnline(['alpha', 'beta']);
    state.channels.beta.live = true; detectOnline(['alpha', 'beta']);
    assert(alertFor('beta'), 'a channel really seen offline and then live still alerts');
    clearAlerts();
    // ...and the refresh itself passes that on: here every lookup fails.
    state.baselineSet = false; state.wasLive = {};
    await new Promise(function (resolve) { fetchFavorites(resolve); });
    assert(state.baselineSet && state.wasLive.alpha === undefined && state.wasLive.beta === undefined, 'a refresh that reached nobody sets no baseline for anyone');
    state.channels.alpha.live = true; state.channels.beta.live = true;

    // During a past video OK is play/pause, so the alert must not promise otherwise.
    var liveCurrent = state.current;
    state.current = null; state.vod = { slug: 'alpha', name: 'Alpha', title: 'Past stream' };
    notifyOnline([{ slug: 'beta', name: 'Beta' }]);
    assert(state.notifyCurrent && notifyText().indexOf('Beta is online') !== -1, 'a live alert still shows during a past video');
    assert(notifyText().indexOf('Press OK') === -1, 'without telling the viewer to press OK, which pauses the video there');
    clearAlerts();
    state.vod = null; state.current = liveCurrent;
    state.channels.beta.live = true;
    notifyOnline([{ slug: 'beta', name: 'Beta' }]);
    assert(notifyText().indexOf('Press OK to watch') !== -1, 'on a live stream the hint is there');
    clearAlerts();

    // A picture that only just came back has not earned a clean slate.
    PB.mediaRetries = 2; PB.netRetries = 3;
    video.dispatchEvent(new Event('playing'));
    assert(PB.mediaRetries === 2 && PB.netRetries === 3, 'the retry counts survive a bare "playing" event, so a stream that keeps failing still escalates');
    PB.mediaRetries = 0; PB.netRetries = 0;

    // An answer that is not channel data is an error, not something to read fields from.
    serviceGet = function (path, cb) { setTimeout(function () { cb(null, null); }, 0); return { cancel: function () {} }; };
    var answer = null;
    apiGet('zeta', function (err, data) { answer = { err: err, data: data }; });
    await fixtureUntil(function () { return answer !== null; });
    assert(!!answer.err && answer.data === undefined, 'an empty answer to a channel lookup comes back as an error');
    serviceGet = real.serviceGet;

    // The idle screen stays behind a dialog that hid it.
    state.current = null;
    showNothing();
    assert(document.getElementById('idle').className.indexOf('hidden') === -1, 'the idle screen shows when nothing plays');
    openAdd();
    assert(document.getElementById('idle').className.indexOf('hidden') !== -1, 'the Add dialog hides it');
    showNothing();                                      // what the 30-second poll does
    assert(document.getElementById('idle').className.indexOf('hidden') !== -1, 'and a background refresh does not bring it back under the dialog');
    closeAdd();
    assert(document.getElementById('idle').className.indexOf('hidden') === -1, 'closing the dialog does');
    state.current = liveCurrent; showState('hidden'); closeSidebar();

    // Live suggestions fetched for one Add dialog reach the dialog that is open when they arrive.
    var calls = [];
    serviceGet = function (path, cb) { calls.push({ path: path, cb: cb }); return { cancel: function () {} }; };
    liveSuggest.list = null; liveSuggest.at = 0; liveSuggest.pending = false; browse.raw = [];
    openAdd();
    assert(calls.length === 1 && /\/stream\/livestreams\//.test(calls[0].path), 'opening Add asks for live channels');
    closeAdd(); openAdd();
    assert(calls.length === 1, 'reopening while that is still on its way does not ask twice');
    var lang = browse.langs[0] || 'en';
    calls[0].cb(null, { data: [{ viewer_count: 10, language: lang, session_title: 't', categories: [{ name: 'Games', slug: 'games' }], channel: { slug: 'zeta', user: { username: 'Zeta' } } }] });
    assert(add.results.some(function (r) { return r.slug === 'zeta'; }), 'and the answer fills the dialog that is open now');
    if (calls[1]) calls[1].cb(null, { data: [] });
    closeAdd(); closeSidebar();
    serviceGet = real.serviceGet;

    // Adding a channel: the list's idle timer starts again, and nothing else is refetched.
    var resets = 0, refreshes = 0;
    apiGet = function (slug, cb) { cb(null, { id: 9, user: { id: 90, username: 'Zeta' }, chatroom: { id: 99 }, livestream: null }); };
    fetchFavorites = function (cb) { refreshes++; if (cb) cb(); };
    resetIdle = function () { resets++; real.resetIdle(); };
    openSidebar(); await fixtureWait();
    openAdd();
    resets = 0;
    addChannelBySlug('zeta');
    assert(isFavorite('zeta') && state.mode === 'player', 'the channel is added and the dialog closes');
    assert(state.order.indexOf('zeta') !== -1 && refreshes === 0, 'it joins the list without refetching every other channel');
    assert(resets > 0, 'and the channel list starts counting down to hide again');
    apiGet = real.apiGet; fetchFavorites = real.fetchFavorites; resetIdle = real.resetIdle;
    removeFavorite('zeta'); delete state.channels.zeta; sortOrder(currentFavoritesWithData()); renderSidebar();

    // Big UI: rows are re-clipped for the new font, not left with the old cut.
    state.channels.alpha.title = new Array(12).join('a very long stream title that cannot fit ');
    renderSidebar('alpha'); await fixtureWait(200);
    function alphaTitle() { return document.querySelector('#fav-list [data-slug="alpha"] .favtitle').textContent; }
    var normal = alphaTitle();
    settings.uiText = 'large'; UIPolish.apply(); sideLayout = null; sideTextStyle = null; renderSidebar('alpha'); await fixtureWait(200);
    var large = alphaTitle();
    assert(normal.length > 10 && large.length < normal.length, 'a larger font shows less of a long title: ' + normal.length + ' -> ' + large.length);
    settings.uiText = 'normal'; UIPolish.apply(); sideLayout = null; sideTextStyle = null; renderSidebar('alpha'); await fixtureWait(200);
    assert(alphaTitle().length === normal.length, 'and going back restores it');
    closeSidebar();
  } finally {
    serviceGet = real.serviceGet; apiGet = real.apiGet; fetchFavorites = real.fetchFavorites; resetIdle = real.resetIdle;
    state.vod = null; state.current = 'alpha'; settings.uiText = 'normal'; UIPolish.apply();
    if (state.mode === 'add') closeAdd();
    clearAlerts(); closeSidebar();
  }
};
