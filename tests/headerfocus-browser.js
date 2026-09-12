window.runHeaderfocusTests = function (assert) {
  function visibleFocus(id, activate, deactivate) {
    var node = document.getElementById(id), before = node.getBoundingClientRect();
    activate();
    var style = getComputedStyle(node), after = node.getBoundingClientRect();
    assert(node.classList.contains('focused'), id + ' receives remote focus');
    assert(style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 && style.outlineColor === 'rgb(83, 252, 24)', id + ' shows a green remote focus outline');
    assert(before.width === after.width && before.height === after.height, id + ' focus does not shift header layout');
    deactivate();
    assert(!node.classList.contains('focused') && getComputedStyle(node).outlineStyle === 'none', id + ' removes its outline when focus moves away');
  }
  document.getElementById('browse').classList.remove('hidden');
  browse.zone = 'header'; browse.headerIdx = BROWSE_HEADERS.length - 2; applyBrowseFocus(true);
  visibleFocus('browse-close', function () { browseMove(1, 0); }, function () { browseMove(-1, 0); });
  document.getElementById('browse').classList.add('hidden');
  document.getElementById('cats').classList.remove('hidden');
  cats.zone = 'grid'; cats.gridIdx = 0; applyCatsFocus(true);
  visibleFocus('cats-search', function () { catsMove(0, -1); }, function () { catsMove(1, 0); });
  assert(document.activeElement !== document.getElementById('cats-search'), 'category search is visibly focused before editing begins');
  catsMove(-1, 0);
  visibleFocus('cats-close', function () { catsMove(1, 0); }, function () { catsMove(-1, 0); });
  document.getElementById('cats').classList.add('hidden');
  document.getElementById('vods').classList.remove('hidden');
  vods.zone = 'header'; vods.headerIdx = 0; applyVodFocus(true);
  visibleFocus('vods-close', function () { vodMove(1, 0); }, function () { vodMove(-1, 0); });
  document.getElementById('vods').classList.add('hidden');
};
