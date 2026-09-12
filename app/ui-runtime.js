/* Bounded UI work for the TV webview. ES5; never persists diagnostic data. */
(function (root) {
  'use strict';
  var own = Object.prototype.hasOwnProperty;
  var limits = { requests: 4, background: 2, queued: 96, listeners: 64,
    cacheEntries: 64, cacheBytes: 2097152, entryBytes: 262144 };
  function later(fn) { return setTimeout(fn, 0); }
  function safe(fn, err, value) { try { fn(err, value); } catch (e) {} }
  function cancelHandle(handle) {
    try {
      if (typeof handle === 'function') handle();
      else if (handle && handle.cancel) handle.cancel();
      else if (handle && handle.abort) handle.abort();
    } catch (e) {}
  }
  function listener(cb) { return { cb: typeof cb === 'function' ? cb : function () {}, cancelled: false }; }
  function deliver(list, err, value) {
    later(function () {
      for (var i = 0; i < list.length; i++) if (!list[i].cancelled) safe(list[i].cb, err, value);
    });
  }
  function onlyListener(item, err, value) {
    deliver([item], err, value);
    return { cancel: function () { item.cancelled = true; } };
  }

  var transport = null, queue = [], jobs = Object.create(null);
  var active = 0, nonPlayback = 0, background = 0, pumpTimer = null;
  function schedule() { if (pumpTimer === null) pumpTimer = later(pump); }
  function finishJob(job, err, value) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    delete jobs[job.key];
    if (job.started) {
      active--;
      if (job.startedPriority > 0) nonPlayback--;
      if (job.startedPriority === 2) background--;
    } else {
      var idx = queue.indexOf(job);
      if (idx !== -1) queue.splice(idx, 1);
    }
    deliver(job.listeners, err, value);
    schedule();
  }
  function pump() {
    pumpTimer = null;
    if (!transport) return;
    while (active < limits.requests) {
      var selected = -1, priority = 3;
      for (var i = 0; i < queue.length; i++) {
        var job = queue[i];
        if (job.priority > 0 && nonPlayback >= limits.requests - 1) continue;
        if (job.priority === 2 && background >= limits.background) continue;
        if (job.priority < priority) { selected = i; priority = job.priority; }
      }
      if (selected === -1) break;
      startJob(queue.splice(selected, 1)[0]);
    }
  }
  function startJob(job) {
    job.started = true; job.startedPriority = job.priority;
    active++;
    if (job.priority > 0) nonPlayback++;
    if (job.priority === 2) background++;
    job.timer = setTimeout(function () {
      finishJob(job, 'timeout'); cancelHandle(job.handle);
    }, 15000);
    try {
      job.handle = transport(job.path, function (err, data) { finishJob(job, err, data); }, job.options);
    } catch (e) { finishJob(job, 'transport'); }
  }
  function request(path, cb, options) {
    var sub = listener(cb), opts = options || {};
    if (typeof path !== 'string' || !path) return onlyListener(sub, 'bad path');
    var key = path + '\n' + (opts.compact === true ? 'compact' : 'raw');
    var priority = opts.priority === 0 ? 0 : opts.priority === 2 ? 2 : 1;
    var job = jobs[key];
    if (job && job.listeners.length >= limits.listeners) return onlyListener(sub, 'busy');
    if (!job) {
      if (queue.length >= limits.queued) {
        // A fresh playback request may displace queued background work.
        var displaced = -1;
        for (var q = queue.length - 1; q >= 0; q--) if (queue[q].priority > priority) { displaced = q; break; }
        if (displaced === -1) return onlyListener(sub, 'busy');
        finishJob(queue[displaced], 'busy');
      }
      job = { key: key, path: path, priority: priority, options: { priority: priority, compact: opts.compact === true },
        listeners: [], started: false, done: false, timer: null, handle: null };
      jobs[key] = job; queue.push(job);
    } else if (!job.started && priority < job.priority) {
      job.priority = priority; job.options.priority = priority;
    }
    job.listeners.push(sub);
    schedule();
    return { cancel: function () {
      if (sub.cancelled) return;
      sub.cancelled = true;
      if (job.done) return;
      var idx = job.listeners.indexOf(sub);
      if (idx !== -1) job.listeners.splice(idx, 1);
      if (!job.listeners.length) { finishJob(job, 'cancelled'); cancelHandle(job.handle); }
    } };
  }

  var cache = Object.create(null), cacheOrder = [], cacheBytes = 0, loads = Object.create(null), loadCount = 0;
  function removeCache(key) {
    if (!own.call(cache, key)) return;
    cacheBytes -= cache[key].bytes; delete cache[key];
    var idx = cacheOrder.indexOf(key); if (idx !== -1) cacheOrder.splice(idx, 1);
  }
  function touch(key) {
    var idx = cacheOrder.indexOf(key); if (idx !== -1) cacheOrder.splice(idx, 1);
    cacheOrder.push(key);
  }
  function remember(key, value, ttl) {
    var bytes;
    try { bytes = JSON.stringify(value).length * 2; } catch (e) { return; }
    if (bytes > limits.entryBytes || ttl <= 0) return;
    removeCache(key);
    while (cacheOrder.length >= limits.cacheEntries || cacheBytes + bytes > limits.cacheBytes) removeCache(cacheOrder[0]);
    cache[key] = { value: value, expires: Date.now() + ttl, bytes: bytes };
    cacheBytes += bytes; touch(key);
  }
  function cached(key, loader, cb, ttl) {
    key = String(key);
    var sub = listener(cb), hit = cache[key], load = loads[key];
    if (hit && hit.expires > Date.now()) { touch(key); return onlyListener(sub, null, hit.value); }
    if (hit) removeCache(key);
    if (load && load.listeners.length >= limits.listeners) return onlyListener(sub, 'busy');
    if (!load) {
      if (loadCount >= limits.queued) return onlyListener(sub, 'busy');
      load = { listeners: [], done: false, handle: null, timer: null };
      loads[key] = load; loadCount++;
      load.listeners.push(sub);
      function complete(err, value) {
        if (load.done) return;
        load.done = true; clearTimeout(load.timer); delete loads[key]; loadCount--;
        if (!err) remember(key, value, typeof ttl === 'number' && isFinite(ttl) ? ttl : 60000);
        deliver(load.listeners, err, value);
      }
      load.complete = complete;
      load.timer = setTimeout(function () { complete('timeout'); cancelHandle(load.handle); }, 20000);
      try { load.handle = loader(complete); } catch (e) { complete('loader'); }
    } else load.listeners.push(sub);
    return { cancel: function () {
      if (sub.cancelled) return;
      sub.cancelled = true;
      if (load.done) return;
      var idx = load.listeners.indexOf(sub); if (idx !== -1) load.listeners.splice(idx, 1);
      if (!load.listeners.length) { load.complete('cancelled'); cancelHandle(load.handle); }
    } };
  }
  root.UIWork = {
    setTransport: function (fn) { transport = typeof fn === 'function' ? fn : null; schedule(); },
    request: request, cached: cached,
    clearCache: function () { cache = Object.create(null); cacheOrder = []; cacheBytes = 0; },
    stats: function () { return { active: active, background: background, queued: queue.length,
      cacheEntries: cacheOrder.length, cacheBytes: cacheBytes, cacheLoads: loadCount }; }
  };

  var doc = root.document, imageRecords = [], imageActive = 0, emoteActive = 0, emoteResident = 0, imageFrame = null;
  var failedImages = Object.create(null), failedOrder = [], pendingImageScans = [];
  var imageLimits = { active: 4, emoteActive: 2, watched: 512, emotes: 96, margin: 320 };
  function failedImage(url) {
    if (!own.call(failedImages, url)) return false;
    var idx = failedOrder.indexOf(url); if (idx !== -1) failedOrder.splice(idx, 1);
    if (failedImages[url] <= Date.now()) { delete failedImages[url]; return false; }
    failedOrder.push(url); return true;
  }
  function rememberImageFailure(url) {
    if (url.length > 2048) return;
    var idx = failedOrder.indexOf(url); if (idx !== -1) failedOrder.splice(idx, 1);
    while (failedOrder.length >= 64) delete failedImages[failedOrder.shift()];
    failedImages[url] = Date.now() + 300000; failedOrder.push(url);
  }
  function attached(el) { return !!(doc && doc.documentElement && doc.documentElement.contains(el)); }
  function emote(el) { return /(^|\s)chat-emote(\s|$)/.test(el.className || '') || el.getAttribute('data-ui-emote') !== null; }
  function imageFallback(rec) {
    var el = rec.el;
    el.setAttribute('data-ui-image-state', 'error');
    if (String(el.tagName).toLowerCase() === 'img') { el.removeAttribute('src'); el.alt = rec.label; }
    else {
      el.style.backgroundImage = '';
      if (!rec.fallback && doc) {
        rec.fallback = doc.createElement('span'); rec.fallback.className = 'ui-image-fallback';
        rec.fallback.style.cssText = 'position:absolute;left:0;right:0;top:40%;text-align:center;pointer-events:none;opacity:.55';
        rec.fallback.textContent = (rec.label || '?').charAt(0).toUpperCase(); el.appendChild(rec.fallback);
      }
    }
  }
  function releaseImage(rec) {
    if (rec.released) return;
    rec.released = true;
    if (rec.finish) rec.finish(false, true);
    else if (rec.emote && rec.state === 'loaded') emoteResident--;
    if (rec.emote && String(rec.el.tagName).toLowerCase() === 'img') rec.el.removeAttribute('src');
    if (rec.fallback && rec.fallback.parentNode) rec.fallback.parentNode.removeChild(rec.fallback);
    if (rec.el._uiImage === rec) rec.el._uiImage = null;
    var idx = imageRecords.indexOf(rec); if (idx !== -1) imageRecords.splice(idx, 1);
  }
  function pruneImages() {
    for (var i = imageRecords.length - 1; i >= 0; i--) {
      // Newly created cards are watched before insertion; keep them until scan.
      var rec = imageRecords[i];
      if (rec.seen && !attached(rec.el)) releaseImage(rec);
    }
  }
  function nearby(el) {
    if (!attached(el) || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect(), margin = imageLimits.margin;
    if (!rect.width || !rect.height) return false;
    var top = 0, left = 0, right = root.innerWidth || 1920, bottom = root.innerHeight || 1080;
    // Respect scroll containers, including a bottom-anchored chat transcript.
    var parent = el.parentNode;
    while (parent && parent !== doc.documentElement && parent.getBoundingClientRect) {
      if (parent.clientHeight && (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth)) {
        var clip = parent.getBoundingClientRect();
        top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
        left = Math.max(left, clip.left); right = Math.min(right, clip.right);
      }
      parent = parent.parentNode;
    }
    return rect.bottom >= top - margin && rect.top <= bottom + margin && rect.right >= left - margin && rect.left <= right + margin;
  }
  function scheduleImages() {
    if (imageFrame !== null) return;
    imageFrame = root.requestAnimationFrame ? root.requestAnimationFrame(pumpImages) : setTimeout(pumpImages, 16);
  }
  function queueImageScan(container) {
    if (container && container.querySelectorAll && pendingImageScans.indexOf(container) === -1) {
      if (pendingImageScans.length >= 8) pendingImageScans.shift();
      pendingImageScans.push(container);
    }
    scheduleImages();
  }
  function pumpImages() {
    imageFrame = null; pruneImages();
    var scans = pendingImageScans; pendingImageScans = [];
    for (var s = 0; s < scans.length; s++) scanImages(scans[s]);
    // Long chat histories must not keep decoding animated images above the
    // viewport or spend the live rows' image budget on distant messages.
    for (var e = 0; e < imageRecords.length; e++) {
      var old = imageRecords[e];
      if (old.emote && (old.state === 'loaded' || old.state === 'loading') && !nearby(old.el)) {
        if (old.finish) old.finish(false, true); else emoteResident--;
        old.state = 'waiting'; old.el.removeAttribute('src'); old.el.setAttribute('data-ui-image-state', 'waiting');
      }
    }
    for (var i = 0; i < imageRecords.length && imageActive < imageLimits.active; i++) {
      var rec = imageRecords[i];
      if (attached(rec.el)) rec.seen = true;
      if (rec.state !== 'waiting' || (rec.emote && (emoteActive >= imageLimits.emoteActive || emoteResident >= imageLimits.emotes)) || !nearby(rec.el)) continue;
      if (failedImage(rec.url)) { rec.state = 'error'; imageFallback(rec); continue; }
      startImage(rec);
    }
  }
  function startImage(rec) {
    if (!root.Image) { rec.state = 'error'; imageFallback(rec); return; }
    var image = new root.Image(), ended = false;
    rec.state = 'loading'; imageActive++; if (rec.emote) { emoteActive++; emoteResident++; }
    rec.el.setAttribute('data-ui-image-state', 'loading');
    function finish(ok, cancelled) {
      if (ended) return; ended = true;
      clearTimeout(rec.timer); image.onload = image.onerror = null;
      imageActive--; if (rec.emote) emoteActive--;
      if (rec.emote && !ok) emoteResident--;
      rec.finish = null; rec.state = ok ? 'loaded' : 'error';
      if (!cancelled && !rec.released && rec.el._uiImage === rec) {
        if (ok) {
          if (String(rec.el.tagName).toLowerCase() === 'img') rec.el.src = rec.url;
          else rec.el.style.backgroundImage = 'url(' + JSON.stringify(rec.url) + ')';
          rec.el.setAttribute('data-ui-image-state', 'loaded');
        } else { rememberImageFailure(rec.url); imageFallback(rec); }
      }
      if (!ok) { try { image.src = ''; } catch (e) {} }
      scheduleImages();
    }
    rec.finish = finish;
    image.onload = function () { finish(true, false); };
    image.onerror = function () { finish(false, false); };
    rec.timer = setTimeout(function () { finish(false, false); }, 15000);
    try { image.src = rec.url; } catch (e) { finish(false, false); }
  }
  function watch(el, url, label) {
    if (!el || !el.setAttribute) return;
    url = typeof url === 'string' ? url : '';
    if (el._uiImage && el._uiImage.url === url) return;
    if (el._uiImage) releaseImage(el._uiImage);
    var isEmote = emote(el);
    if (isEmote) {
      // Distant chat history stays in the DOM as readable text, outside the
      // registry. A later scroll scan admits it only when it becomes nearby.
      if (el.getAttribute('data-ui-src') !== url) el.setAttribute('data-ui-src', url);
      var emoteLabel = String(label || el.alt || 'Image').slice(0, 256);
      if (el.alt !== emoteLabel) el.alt = emoteLabel;
      if (attached(el) && !nearby(el)) return;
    }
    pruneImages();
    if (imageRecords.length >= imageLimits.watched) {
      var evict = -1;
      for (var i = 0; i < imageRecords.length; i++) {
        if (!nearby(imageRecords[i].el)) { evict = i; break; }
      }
      // Keep admitted nearby images stable even if one scan sees more nodes
      // than the registry can hold. Never evict them merely to re-add them.
      if (evict === -1) return;
      releaseImage(imageRecords[evict]);
    }
    var rec = { el: el, url: url, label: String(label || el.alt || 'Image').slice(0, 256), emote: isEmote,
      state: 'waiting', seen: attached(el), released: false, fallback: null, finish: null };
    if (String(el.tagName).toLowerCase() === 'img') { el.alt = rec.label; el.removeAttribute('src'); el.setAttribute('decoding', 'async'); }
    else {
      el.style.backgroundImage = '';
      // An avatar's initial yields to the image; preserve nested card controls.
      if (url && el.children && !el.children.length) el.textContent = '';
    }
    el._uiImage = rec; imageRecords.push(rec);
    if (!url || failedImage(url)) { rec.state = 'error'; imageFallback(rec); return; }
    el.setAttribute('data-ui-image-state', 'waiting'); scheduleImages();
  }
  function scanImages(container) {
    if (container && container.querySelectorAll) {
      var elements = container.querySelectorAll('[data-ui-src], [data-src]');
      for (var i = 0; i < elements.length; i++) watch(elements[i], elements[i].getAttribute('data-ui-src') || elements[i].getAttribute('data-src'), elements[i].getAttribute('alt') || elements[i].getAttribute('aria-label'));
    }
  }
  root.UIImages = {
    watch: watch,
    scan: function (container) { scanImages(container || doc); scheduleImages(); },
    release: function (container) {
      for (var i = imageRecords.length - 1; i >= 0; i--) {
        var el = imageRecords[i].el;
        if (!container || el === container || (container.contains && container.contains(el))) releaseImage(imageRecords[i]);
      }
    },
    stats: function () { return { active: imageActive, emoteActive: emoteActive, emoteResident: emoteResident,
      watched: imageRecords.length, failedURLs: failedOrder.length }; }
  };
  if (root.addEventListener) {
    root.addEventListener('scroll', function (event) { queueImageScan(event.target || doc); }, true);
    root.addEventListener('resize', function () { queueImageScan(doc); }, false);
  }
}(typeof window !== 'undefined' ? window : this));
