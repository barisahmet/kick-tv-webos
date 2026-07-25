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

function kickGet(path, cb) {
  // One answer per request, whatever happens. The request and the response are
  // separate event sources and an abort can fire both, so without this guard a
  // single fetch could respond twice on the same Luna message.
  var settled = false;
  function finish(err, status, body) {
    if (settled) return;
    settled = true;
    cb(err, status, body);
  }
  var req = https.get({
    host: 'kick.com',
    path: path,
    headers: BROWSER_HEADERS,
    ciphers: CHROME_CIPHERS,
    ecdhCurve: CHROME_CURVES,
    agent: KEEPALIVE_AGENT
  }, function (res) {
    res.setEncoding('utf8');   // decode across chunk boundaries so a split emoji cannot corrupt the JSON
    var body = '';
    var expected = parseInt(res.headers['content-length'], 10);
    res.on('data', function (d) { body += d; });
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
  });
  req.on('error', function (e) { finish(String(e && e.message || e)); });
  req.setTimeout(10000, function () { req.abort(); });
}

// The app calls this over the Luna bus with a kick.com path, either a channel
// lookup (/api/v2/channels/name) or the live directory (/stream/livestreams/...).
service.register('fetch', function (message) {
  var path = message.payload && message.payload.path;
  if (typeof path !== 'string' || (path.indexOf('/api/') !== 0 && path.indexOf('/stream/') !== 0)) {
    message.respond({ ok: false, error: 'bad path' });
    return;
  }
  kickGet(path, function (err, status, body) {
    if (err) message.respond({ ok: false, error: err });
    else message.respond({ ok: true, status: status, body: body });
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
