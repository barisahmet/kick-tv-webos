/*
  Background service for Kick TV. It runs outside the web view and fetches
  Kick's data on the app's behalf.

  There are two reasons the app needs this. First, a page running on the TV
  cannot call kick.com directly because of browser security rules, and Kick does
  not send the headers that would allow it. Second, and this is the tricky part,
  Kick sits behind Cloudflare, which looks at the shape of the TLS handshake and
  blocks anything that does not look like a real browser. Plain Node.js gets
  turned away with a 403 here. The trick is to send the same cipher list and
  curves that Chrome sends, which is what the constants below do. Tested on a
  webOS 22 TV: the default handshake gets a 403, the Chrome style handshake gets
  a 200. Please leave the ciphers and ecdhCurve settings in place.
*/
var Service = require('webos-service');
var https = require('https');

var service = new Service('com.barisahmet.kicktv.service');

var UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 ' +
         '(KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';

// The cipher order and curves a recent Chrome offers. This is what gets us past
// Cloudflare. Changing the order can bring the 403 back.
var CHROME_CIPHERS = [
  'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  'AES128-GCM-SHA256', 'AES256-GCM-SHA384'
].join(':');
var CHROME_CURVES = 'X25519:prime256v1:secp384r1';

// Reuse connections: without keep-alive every request pays a full TLS
// handshake (~0.5s), which made paginated browsing crawl.
var KEEPALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 6 });

var BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://kick.com/'
};

// The app gives up on a call after 12s, so answering later only ties up one of
// the six keep-alive sockets for nothing. The socket timeout below is idle time
// only; a response that trickles in a byte at a time would never trip it.
var REQUEST_DEADLINE_MS = 11000;
// Kick's largest real payloads are a few hundred KB. Anything far past that is
// not something the app can use, and buffering it would starve the TV of memory.
var MAX_BODY_BYTES = 8 * 1024 * 1024;

function kickGet(path, cb) {
  // One answer per request, whatever happens. The request and the response are
  // separate event sources and an abort can fire both, so without this guard a
  // single fetch could respond twice on the same Luna message.
  var settled = false, req = null, deadline = null;
  function finish(err, status, body) {
    if (settled) return;
    settled = true;
    if (deadline) clearTimeout(deadline);
    cb(err, status, body);
  }
  function giveUp(reason) {
    finish(reason);
    if (req) { try { req.abort(); } catch (e) {} }
  }
  try {
    req = https.get({
      host: 'kick.com',
      path: path,
      headers: BROWSER_HEADERS,
      ciphers: CHROME_CIPHERS,
      ecdhCurve: CHROME_CURVES,
      agent: KEEPALIVE_AGENT
    }, onResponse);
  } catch (e) {
    // https.get throws synchronously on some bad paths; that must still answer.
    finish(String(e && e.message || e));
    return;
  }
  deadline = setTimeout(function () { giveUp('timeout'); }, REQUEST_DEADLINE_MS);
  function onResponse(res) {
    res.setEncoding('utf8');   // decode across chunk boundaries so a split emoji cannot corrupt the JSON
    var body = '', bytes = 0;
    var expected = parseInt(res.headers['content-length'], 10);
    if (expected > MAX_BODY_BYTES) { giveUp('too large'); return; }
    res.on('data', function (d) {
      if (settled) return;
      bytes += Buffer.byteLength(d, 'utf8');
      if (bytes > MAX_BODY_BYTES) { giveUp('too large'); return; }
      body += d;
    });
    // The timeout below is a socket inactivity timeout, so it can abort a response
    // that is already half-read. This Node build still emits 'end' after 'aborted',
    // which would otherwise hand the app a truncated body under a 200. Catch the
    // cut here, and check the length for the same reason. Newer Node emits 'error'
    // on the response instead — unhandled, that would take the whole service down.
    res.on('aborted', function () { finish('response aborted'); });
    res.on('error', function (e) { finish('response ' + String(e && e.message || e)); });
    res.on('end', function () {
      if (!isNaN(expected) && Buffer.byteLength(body, 'utf8') < expected) {
        finish('truncated response');
        return;
      }
      finish(null, res.statusCode, body);
    });
  }
  req.on('error', function (e) { finish(String(e && e.message || e)); });
  req.setTimeout(10000, function () { req.abort(); });
}

// Projection is opt-in and limited to endpoints whose payloads the app consumes.
// Keep absent properties absent, nulls null, and wrapper/array shapes unchanged.
// Image descriptors stay intact: their srcset/responsive variants matter on TV.
function selectFields(value, fields, nested) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  var out = {}, i, key;
  for (i = 0; i < fields.length; i++) {
    key = fields[i];
    if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
  }
  for (key in nested) if (Object.prototype.hasOwnProperty.call(nested, key) && Object.prototype.hasOwnProperty.call(value, key)) {
    out[key] = nested[key](value[key]);
  }
  return out;
}
function mapItems(value, project) { return Array.isArray(value) ? value.map(project) : value; }
function projectUser(value) { return selectFields(value, ['id', 'username', 'profile_pic'], {}); }
function projectCategory(value) {
  return selectFields(value, ['id', 'name', 'slug', 'banner', 'viewers', 'viewer_count', 'livestreams_count'], {});
}
function projectCategories(value) { return mapItems(value, projectCategory); }
function projectStream(value) {
  return selectFields(value, ['id', 'slug', 'is_live', 'viewer_count', 'language', 'session_title', 'created_at', 'thumbnail'], {
    categories: projectCategories,
    channel: function (channel) { return selectFields(channel, ['id', 'slug'], { user: projectUser }); }
  });
}
function projectChannel(value) {
  return selectFields(value, ['id', 'slug', 'playback_url', 'followers_count', 'followersCount', 'isLive', 'is_live'], {
    user: projectUser,
    livestream: projectStream,
    chatroom: function (room) { return selectFields(room, ['id'], {}); }
  });
}
function projectVod(value) {
  return selectFields(value, ['id', 'uuid', 'source', 'duration', 'created_at', 'session_title', 'is_live', 'views', 'thumbnail'], {
    categories: projectCategories,
    // Nested ids anchor resume progress; thumb.src is the fallback poster.
    video: function (video) { return selectFields(video, ['id', 'uuid', 'thumb'], {}); }
  });
}
function projectEnvelope(value, field, project) {
  if (Array.isArray(value)) return mapItems(value, project);
  if (!value || typeof value !== 'object') return value;
  var out = {}, key;
  // Preserve pagination metadata and unfamiliar wrappers rather than invent a
  // different response contract when Kick adds fields around a known list.
  for (key in value) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
  if (Object.prototype.hasOwnProperty.call(value, field)) out[field] = mapItems(value[field], project);
  return out;
}
function compactResponse(path, body) {
  var endpoint = path.split('?')[0], project = null;
  if (/^\/api\/v2\/channels\/[^/]+\/videos$/.test(endpoint)) {
    project = function (value) { return projectEnvelope(value, 'data', projectVod); };
  } else if (/^\/api\/v[12]\/channels\/[^/]+$/.test(endpoint)) project = projectChannel;
  else if (/^\/stream\/livestreams\/[^/]+$/.test(endpoint)) {
    project = function (value) { return projectEnvelope(value, 'data', projectStream); };
  } else if (endpoint === '/api/v1/subcategories') {
    project = function (value) { return projectEnvelope(value, 'data', projectCategory); };
  } else if (endpoint === '/api/search') {
    project = function (value) {
      return projectEnvelope(projectEnvelope(value, 'channels', projectChannel), 'categories', projectCategory);
    };
  }
  if (!project) return body;
  try { return JSON.stringify(project(JSON.parse(body))); } catch (e) { return body; }
}

// The app calls this over the Luna bus with a kick.com path, either a channel
// lookup (/api/v2/channels/name) or the live directory (/stream/livestreams/...).
service.register('fetch', function (message) {
  var path = message.payload && message.payload.path;
  // Printable ASCII only: the app always encodes its paths, and a raw space or
  // non-ASCII character makes https.get throw instead of sending anything.
  if (typeof path !== 'string' || !/^[\x21-\x7e]+$/.test(path) ||
      (path.indexOf('/api/') !== 0 && path.indexOf('/stream/') !== 0)) {
    message.respond({ ok: false, error: 'bad path' });
    return;
  }
  kickGet(path, function (err, status, body) {
    if (err) message.respond({ ok: false, error: err });
    else message.respond({ ok: true, status: status,
      body: message.payload.compact === true && status === 200 ? compactResponse(path, body) : body });
  });
});

// A small health check, handy when poking at the service by hand.
service.register('info', function (message) {
  message.respond({
    ok: true,
    node: process.version,
    openssl: process.versions.openssl,
    platform: process.platform + '/' + process.arch
  });
});

/* Backup and restore from a phone. The TV has no files and a poor keyboard, so
   while the app's Backup popup is open this serves a small page on the home
   network (the TV shows its address as a QR code). The phone can download the
   app's saved data, or send a backup file or a list of channel names back. The
   app polls for what arrives and asks on the TV before applying anything.
   The secret token in the path keeps other devices on the network out, and the
   server shuts itself down once the app stops polling. */
var http = require('http');
var os = require('os');

var SHARE_PORT = 8764;
var SHARE_IDLE_MS = 20000;              // the app polls every 2s while the popup is open
var SHARE_MAX_UPLOAD = 2 * 1024 * 1024;
var share = { server: null, port: 0, token: '', backup: '', names: [], inbox: null,
              lastPoll: 0, visits: 0, idleTimer: null };

function lanAddresses() {
  var out = [], ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    });
  });
  // Private home ranges first; anything else (link-local and so on) is a last resort.
  function rank(ip) { return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : 1; }
  return out.sort(function (a, b) { return rank(a) - rank(b); });
}

function stopShare() {
  if (share.idleTimer) { clearInterval(share.idleTimer); share.idleTimer = null; }
  if (share.server) { try { share.server.close(); } catch (e) {} share.server = null; }
  share.port = 0; share.inbox = null; share.backup = ''; share.names = []; share.visits = 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function sharePage() {
  var names = share.names.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('');
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Kick TV backup</title><style>' +
    'body{font:16px/1.45 -apple-system,system-ui,sans-serif;background:#0b0e0f;color:#e7e9ea;margin:0;padding:20px;max-width:560px}' +
    'h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p{color:#9a9a9d;margin:6px 0}' +
    'a.btn,button{display:inline-block;background:#53fc18;color:#0b0e0f;font-weight:700;border:0;border-radius:10px;' +
    'padding:12px 18px;font-size:16px;text-decoration:none}' +
    'textarea{width:100%;box-sizing:border-box;min-height:110px;background:#17191b;color:#e7e9ea;border:1px solid #3a3d40;' +
    'border-radius:10px;padding:10px;font-size:16px}input[type=file]{color:#9a9a9d;margin:6px 0 10px}' +
    'ul{columns:2;padding-left:18px;color:#b7bbbd;margin:8px 0}#msg{margin-top:14px;font-weight:700}' +
    '</style></head><body>' +
    '<h1>Kick TV</h1><p>Your channels and settings, from the TV.</p>' +
    '<h2>Back up</h2><p>' + share.names.length + ' channels</p><ul>' + names + '</ul>' +
    '<a class="btn" href="backup.json" download="kick-tv-backup.json">Download backup</a>' +
    '<h2>Restore</h2><p>Pick a backup file saved from here. The TV asks before it changes anything.</p>' +
    '<input type="file" id="file" accept=".json,application/json">' +
    '<h2>Add channels</h2><p>Channel names or kick.com links, one per line or separated by commas.</p>' +
    '<textarea id="names" placeholder="xqc, trainwreckstv"></textarea>' +
    '<p><button id="send">Send to TV</button></p><div id="msg"></div>' +
    '<script>' +
    'var msg=document.getElementById("msg");' +
    'function post(body){msg.textContent="Sending...";fetch("restore",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})' +
    '.then(function(r){return r.json()}).then(function(j){msg.textContent=j.ok?"Sent. Confirm on the TV.":("Not sent: "+(j.error||"error"))})' +
    '.catch(function(){msg.textContent="Could not reach the TV. Is the Backup screen still open?"})}' +
    'document.getElementById("file").onchange=function(e){var f=e.target.files[0];if(!f)return;var rd=new FileReader();' +
    'rd.onload=function(){var d;try{d=JSON.parse(rd.result)}catch(x){msg.textContent="That file is not a Kick TV backup.";return}' +
    'post({kind:"backup",data:d})};rd.readAsText(f)};' +
    'document.getElementById("send").onclick=function(){var t=document.getElementById("names").value;' +
    'var l=t.split(/[\\s,;]+/).filter(function(x){return x});if(!l.length){msg.textContent="Type at least one name.";return}' +
    'post({kind:"names",data:l})};' +
    '</script></body></html>';
}

function shareHandler(req, res) {
  var parts = String(req.url || '').split('?')[0].split('/');   // ['', token, file]
  if (parts[1] !== share.token || !share.token) { res.writeHead(404); res.end(); return; }
  var file = parts[2] || '';
  function json(code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  if (req.method === 'GET' && parts.length === 2) {           // /token -> /token/ so relative links work
    res.writeHead(302, { Location: '/' + share.token + '/' }); res.end(); return;
  }
  if (req.method === 'GET' && file === '') {
    share.visits++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(sharePage());
    return;
  }
  if (req.method === 'GET' && file === 'backup.json') {
    res.writeHead(200, { 'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="kick-tv-backup.json"', 'Cache-Control': 'no-store' });
    res.end(share.backup);
    return;
  }
  if (req.method === 'POST' && file === 'restore') {
    var size = 0, chunks = [], over = false;
    req.on('data', function (c) {
      size += c.length;
      if (size > SHARE_MAX_UPLOAD) { over = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (over) return;
      var body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json(400, { ok: false, error: 'not JSON' }); return; }
      if (!body || (body.kind !== 'backup' && body.kind !== 'names') || body.data === undefined) {
        json(400, { ok: false, error: 'unknown request' }); return;
      }
      share.inbox = { kind: body.kind, data: body.data, at: Date.now() };
      json(200, { ok: true });
    });
    return;
  }
  res.writeHead(404); res.end();
}

function startShare(cb) {
  if (share.server) { cb(null); return; }
  var server = http.createServer(shareHandler);
  var triedFallback = false;
  server.on('error', function (e) {
    // our usual port taken (another copy, another app): any free port will do
    if (!triedFallback && e && e.code === 'EADDRINUSE') { triedFallback = true; server.listen(0, '0.0.0.0'); return; }
    if (share.server === server) stopShare();
    cb(String(e && e.message || e));
  });
  server.on('listening', function () {
    share.server = server;
    share.port = server.address().port;
    share.idleTimer = setInterval(function () {
      if (Date.now() - share.lastPoll > SHARE_IDLE_MS) stopShare();
    }, 5000);
    cb(null);
  });
  server.listen(SHARE_PORT, '0.0.0.0');
}

// payload: { token, backup (JSON text), names (display names) }
service.register('shareStart', function (message) {
  var p = message.payload || {};
  if (typeof p.token !== 'string' || !/^[A-Za-z0-9]{12,64}$/.test(p.token) || typeof p.backup !== 'string') {
    message.respond({ ok: false, error: 'bad request' }); return;
  }
  share.token = p.token;
  share.backup = p.backup;
  share.names = Array.isArray(p.names) ? p.names.slice(0, 2000).map(String) : [];
  share.lastPoll = Date.now();
  startShare(function (err) {
    if (err) { message.respond({ ok: false, error: err }); return; }
    message.respond({ ok: true, port: share.port, addresses: lanAddresses() });
  });
});

// Hands over whatever the phone sent since the last poll (once), and keeps the server alive.
service.register('sharePoll', function (message) {
  var p = message.payload || {};
  share.lastPoll = Date.now();
  var running = !!share.server && p.token === share.token;
  var inbox = running ? share.inbox : null;
  if (running) share.inbox = null;
  message.respond({ ok: true, running: running, visits: running ? share.visits : 0, inbox: inbox });
});

service.register('shareStop', function (message) {
  stopShare();
  message.respond({ ok: true });
});
