'use strict';
/* One balloon, shared by anything that wants to explain itself on hover. */

/* Small helpers */
function toast(msg) {
  dimToastShowing = false;   // a new toast replaces the dim popup; dimQuickKey re-flags its own
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.style.filter = popupDimFilter();
  t.className = '';
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(function () { t.className = 'hidden'; }, 2500);
}
function setMode(mode) {
  state.mode = mode;
  document.getElementById('addmodal').className = (mode === 'add') ? '' : 'hidden';
  document.getElementById('confirmmodal').className = (mode === 'confirm') ? '' : 'hidden';
  // hide the idle message behind a dialog so its text does not show through
  if (mode === 'add' || mode === 'confirm') document.getElementById('idle').className = 'hidden';
}

