window.runDetailsTests = async function (assert) {
  function hidden() { var panel = document.getElementById('ui-details'); return !panel || panel.classList.contains('hidden'); }
  function waitShown() { return fixtureUntil(function () { return !hidden(); }); }
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:500px;top:150px;width:900px;height:600px;overflow:auto';
  document.body.appendChild(host);
  var grid = new VirtualGrid(host, { columns: 2 });
  host.style.position = 'fixed';
  var items = []; for (var i = 0; i < 100; i++) items.push({ id: i, title: 'Stream ' + i });
  grid.setItems(items, function (item) { return item.id; }, function (item) {
    var card = document.createElement('div'); card.style.cssText = 'width:400px;height:260px;margin:8px';
    card.textContent = item.title; return card;
  });
  await fixtureWait();
  var anchor = grid.get(0); anchor.setAttribute('aria-describedby', 'existing-description');
  UIPolish.details('browse', items[0], anchor); await waitShown();
  assert(!hidden(), 'Browse details appear after a stable dwell');
  host.scrollTop = 20; await fixtureWait();
  assert(hidden() && document.documentElement.contains(anchor), 'small catalogue scroll dismisses details even while the card stays mounted');
  assert(anchor.getAttribute('aria-describedby') === 'existing-description', 'scroll dismissal restores the previous accessible description');
  UIPolish.details('category', items[0], anchor);
  host.scrollTop = 40; await fixtureWait(750);
  assert(hidden(), 'scrolling cancels pending category details before their dwell expires');
  UIPolish.details('category', items[0], anchor); await waitShown();
  assert(!hidden(), 'a new stable focus can show details after scrolling');
  // Removing just an unrelated card must not dismiss the active description.
  var other = grid.get(1); other.parentNode.removeChild(other); await fixtureWait();
  assert(!hidden(), 'unrelated card removal preserves active details');
  anchor.parentNode.removeChild(anchor); await fixtureWait();
  assert(hidden(), 'removing an already described card dismisses its tooltip');
  assert(anchor.getAttribute('aria-describedby') === 'existing-description', 'anchor removal clears the tooltip description reference');
  grid.clear();
  grid.setItems(items, function (item) { return item.id; }, function (item) {
    var node = document.createElement('div'); node.style.cssText = 'width:400px;height:260px;margin:8px'; node.textContent = item.title; return node;
  });
  await fixtureWait(); anchor = grid.focus(50);
  UIPolish.details('browse', items[50], anchor); await waitShown();
  assert(!hidden(), 'remote focus after scrolling can show the newly focused card details');
  document.body.removeChild(host); await fixtureWait();
  assert(hidden(), 'removing the entire catalogue also dismisses its details');
  UIPolish.cancelDetails();
};
