// Isolated desktop fixture runner. Never connects to a configured device or TV.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const cp = require('child_process');
const root = path.resolve(__dirname, '..');
const selected = process.argv.slice(2).filter(a => !a.startsWith('--'));
const suites = selected.length ? selected : ['settingscontrols', 'chatfollow', 'headerfocus', 'details', 'settings', 'app', 'hotpaths', 'grid', 'visual', 'livebar', 'fixes'];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-ui-browser-'));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-ui-results-'));
let chrome, ws, nextId = 0;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 45000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let file = path.resolve(root, '.' + url.pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    let data = fs.readFileSync(file);
    if (url.pathname === '/app/index.html') {
      data = data.toString().replace('<script src="hls.min.js"></script>', '<script src="/tests/fixture.js"></script>')
        .replace('<script src="favorites.js"></script>', '')
        .replace('</body>', suites.map(s => '<script src="/tests/' + s + '-browser.js"></script>').join('\n') + '</body>');
    } else if (url.pathname === '/app/app.js') {
      data = data.toString().replace(/\(function boot\(\) \{[\s\S]*$/, '');
    }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'application/json');
    res.end(data);
  } catch (e) { res.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  chrome = cp.spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-features=MediaRouter',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1920,1080', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  chrome.on('error', e => { stderr += e.message; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100);
  if (!fs.existsSync(portFile)) throw new Error('Local Chrome did not start: ' + stderr);
  const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  ws = new WebSocket('ws://127.0.0.1:' + port + endpoint);
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timeout);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
    } else if (msg.method === 'Fetch.requestPaused') {
      const local = msg.params.request.url.startsWith(origin + '/') || msg.params.request.url.startsWith('data:');
      send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId: msg.params.requestId } :
        { requestId: msg.params.requestId, errorReason: 'BlockedByClient' }, msg.sessionId).catch(() => {});
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const results = [];
  for (const suite of suites) {
    await send('Page.navigate', { url: origin + '/app/index.html?suite=' + suite }, sessionId);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await evaluate('document.readyState === "complete" && typeof ChatWindow !== "undefined" && typeof settings !== "undefined"');
      if (ready) break;
      await delay(50);
    }
    if (!ready) throw new Error('Fixture not ready');
    const testName = 'run' + suite[0].toUpperCase() + suite.slice(1) + 'Tests';
    const checks = await evaluate(`(async function () {
      fixtureInit();
      var checks = [];
      function assert(condition, message) { if (!condition) throw new Error(message); checks.push(message); }
      await window[${JSON.stringify(testName)}](assert);
      assert(fixtureErrors.length === 0, 'no uncaught fixture errors: ' + fixtureErrors.join('; '));
      return checks;
    })()`);
    results.push({ suite, checks });
    console.log(suite + ': ' + checks.length + ' checks passed');
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(artifacts, suite + '.png'), Buffer.from(shot.data, 'base64'));
    if (suite === 'visual') {
      for (const mode of ['settings-normal', 'settings-large', 'settings-controls-normal', 'settings-controls-large', 'dim-large', 'chat-large', 'vods-long', 'vods-empty']) {
        await evaluate('setupVisualScreenshot(' + JSON.stringify(mode) + ')');
        const screen = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
        fs.writeFileSync(path.join(artifacts, mode + '.png'), Buffer.from(screen.data, 'base64'));
      }
    }
  }
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  console.log('Local artifacts: ' + artifacts);
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => {
  if (ws) ws.close();
  if (chrome) { chrome.kill(); await delay(300); }
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
});
