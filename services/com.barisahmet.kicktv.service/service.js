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
