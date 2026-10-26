/* The removed catalogue tooltip has been replaced by prepared stream previews. */
window.runDetailsTests = async function (assert) {
  var pending = [], current = 'beta', positions = 0;
  var realFetch = fetchPreviewUrl;
  fetchPreviewUrl = function (slug, done, urgent) { pending.push({ slug: slug, done: done, urgent: urgent }); };
  state.channels.gamma = { slug: 'gamma', name: 'Gamma', live: true, title: 'Another preview' };
  var panel = document.getElementById('sidepreview');
  var controller = makePreviewCard('sidepreview', function () { return current; }, function () { positions++; });
  function ready(slug) { previewCache[slug] = { t: Date.now(), url: 'fixture:' + slug, ready: true, bitmap: fixtureFrame() }; }
  try {
    controller.update(); controller.cancel(); await fixtureWait(200);
    assert(pending.length === 0 && panel.classList.contains('hidden'), 'leaving before preview dwell avoids a request and a popup');
    controller.update(); await fixtureUntil(function () { return pending.length === 1; });
    assert(pending[0].urgent === true && panel.classList.contains('loading'), 'stable focus requests a foreground preview');
    current = 'gamma'; controller.update();
    ready('beta'); pending[0].done();
    assert(panel._frameSlug !== 'beta', 'late preview cannot paint the previous channel after focus moves');
    await fixtureUntil(function () { return pending.length === 2; });
    ready('gamma'); pending[1].done();
    assert(panel._frameSlug === 'gamma' && panel.className === '', 'decoded frame replaces the spinner for the selected channel');
    var canvas = panel.querySelector('canvas'), count = pending.length;
    controller.update();
    assert(panel.querySelector('canvas') === canvas && pending.length === count, 'same focused channel retains its prepared frame without refetching');
    current = null; controller.update();
    assert(panel.classList.contains('hidden'), 'invalid focus hides the preview');
    current = 'beta'; controller.update();
    assert(panel._frameSlug === 'beta' && panel.className === '', 'warmed channel displays immediately without a dwell');
    current = 'alpha'; controller.update();
    assert(panel.classList.contains('hidden'), 'the playing channel does not cover itself with a preview');
    current = 'gamma'; delete previewCache.gamma; controller.update();
    await fixtureUntil(function () { return pending.length === 3; });
    controller.cancel(); ready('gamma'); pending[2].done();
    assert(panel.classList.contains('hidden'), 'closing a panel invalidates its outstanding preview callback');
    assert(positions > 0, 'visible preview states use the placement callback');
  } finally { controller.cancel(); fetchPreviewUrl = realFetch; }
};
