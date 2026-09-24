/* Synthetic fixtures only; the runner also blocks all non-local requests. */
var fixtureStore = {}, fixtureWrites = {}, fixtureErrors = [], fixtureRequests = [];
var SEED_FAVORITES = [];
Object.defineProperty(window, 'localStorage', { value: {
  getItem: function (key) { return fixtureStore[key] || null; },
  setItem: function (key, value) { fixtureStore[key] = String(value); fixtureWrites[key] = (fixtureWrites[key] || 0) + 1; },
  removeItem: function (key) { delete fixtureStore[key]; }
} });
window.addEventListener('error', function (event) { if (event.message) fixtureErrors.push(event.message); });
window.addEventListener('unhandledrejection', function (event) { fixtureErrors.push(String(event.reason)); });
window.XMLHttpRequest = function () {
  this.open = function (method, url) { this.url = url; };
  this.setRequestHeader = function () {};
  this.send = function () { fixtureRequests.push(this.url); var xhr = this; setTimeout(function () { if (xhr.onerror) xhr.onerror(); }, 0); };
  this.abort = function () {};
};
window.WebSocket = function () {
  this.readyState = 1; this.send = function () {};
  this.close = function () { this.readyState = 3; if (this.onclose) this.onclose(); };
};
window.fixtureWait = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms == null ? 70 : ms); }); };
window.fixtureUntil = async function (ready) {
  var deadline = Date.now() + 1500;
  while (!ready() && Date.now() < deadline) await fixtureWait(16);
};
window.fixtureInit = function () {
  UIWork.setTransport(function (path, done) { fixtureRequests.push(path); var timer = setTimeout(function () { done('fixture'); }, 0); return function () { clearTimeout(timer); }; });
  state.ready = true; state.mode = 'player';
  state.channels.alpha = { slug: 'alpha', name: 'Alpha', live: true, viewers: 1234, title: 'A long fixture title for local UI checks', chatroomId: 1 };
  state.channels.beta = { slug: 'beta', name: 'Beta', live: true, viewers: 4321, title: 'Another stream', chatroomId: 2 };
  state.order = ['alpha', 'beta']; state.current = 'alpha'; state.lastFetch = Date.now();
  lsSet('kicktv.added', ['alpha', 'beta']);
  loadSettings(); ChatWindow.init(); UIPolish.init();
  document.getElementById('idle').className = 'hidden';
  document.getElementById('video').style.display = 'none';
};
