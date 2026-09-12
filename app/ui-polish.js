/* Stable details and local overlay geometry. ES5 for webOS Chromium 87. */
(function (root) {
  'use strict';
  var doc = root.document;
  var dwell = 650;
  var detailTimer = null;
  var detailObserver = null;
  var detailScrolls = [];
  var detailAnchor = null;
  var detailKey = '';
  var oldDescription = null;
  var initialized = false;
  var appliedText = null;
  var panelIds = ['settingsbox', 'qualityoptbox', 'dimoptbox', 'chatoptbox', 'blockedcatsbox'];
  var obstacleIds = panelIds.concat(['chat', 'sidebar', 'player-tools', 'cbguide', 'overlay', 'vodbar', 'notify', 'settings-desc', 'quality-hint']);

  function byId(id) { return doc.getElementById(id); }
  function value() { return root.settings || {}; }
  function viewport() {
    return { width: root.innerWidth || 1920, height: root.innerHeight || 1080, bottom: 0 };
  }
  function visible(node) {
    if (!node || !doc.documentElement.contains(node)) return false;
    var current = node;
    while (current && current.nodeType === 1) {
      if (current.classList.contains('hidden')) return false;
      var style = root.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      current = current.parentElement;
    }
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function clamp(n, low, high) { return Math.max(low, Math.min(high, n)); }
  function overlap(a, b) {
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  }
  function rectAt(left, top, width, height) {
    return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
  }
  function place(panel, anchor) {
    if (typeof panel === 'string') panel = byId(panel);
    if (typeof anchor === 'string') anchor = byId(anchor);
    if (!panel || !panel.offsetWidth || !panel.offsetHeight) return null;
    var view = viewport(), pad = 24, gap = 20;
    var availableHeight = Math.max(80, view.height - view.bottom - pad * 2);
    panel.style.maxHeight = availableHeight + 'px';
    panel.style.maxWidth = Math.max(80, view.width - pad * 2) + 'px';
    var original = panel.getBoundingClientRect();
    var width = original.width, height = original.height;
    var maxX = Math.max(pad, view.width - width - pad);
    var maxY = Math.max(pad, view.height - view.bottom - height - pad);
    var target = anchor && visible(anchor) ? anchor.getBoundingClientRect() : null;
    var candidates = [], obstacles = [], i;
    function add(x, y) { candidates.push(rectAt(clamp(x, pad, maxX), clamp(y, pad, maxY), width, height)); }
    if (target) {
      add(target.left - width - gap, target.top + (target.height - height) / 2);
      add(target.right + gap, target.top + (target.height - height) / 2);
      add(target.left + (target.width - width) / 2, target.top - height - gap);
      add(target.left + (target.width - width) / 2, target.bottom + gap);
    }
    add(original.left, original.top);
    add(maxX, pad); add(pad, pad); add(maxX, maxY); add(pad, maxY);
    for (i = 0; i < obstacleIds.length; i++) {
      var node = byId(obstacleIds[i]);
      if (!node || node === panel || node.contains(panel) || panel.contains(node) || !visible(node)) continue;
      if (node.id === 'chat' && !node.classList.contains('on')) continue;
      if (node.id === 'sidebar' && !node.classList.contains('open')) continue;
      if (node.id === 'notify' && !node.classList.contains('show')) continue;
      var obstacle = node.getBoundingClientRect();
      obstacles.push(obstacle);
      add(obstacle.left - width - gap, target ? target.top : original.top);
      add(obstacle.right + gap, target ? target.top : original.top);
      add(target ? target.left : original.left, obstacle.top - height - gap);
      add(target ? target.left : original.left, obstacle.bottom + gap);
    }
    var best = candidates[0], bestScore = Infinity;
    for (i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var score = i * 0.01;
      if (target) {
        score += overlap(candidate, target) * 16;
        score += (Math.abs(candidate.left + width / 2 - target.left - target.width / 2) +
          Math.abs(candidate.top + height / 2 - target.top - target.height / 2)) * 0.02;
      }
      for (var j = 0; j < obstacles.length; j++) score += overlap(candidate, obstacles[j]);
      if (score < bestScore) { bestScore = score; best = candidate; }
    }
    // getBoundingClientRect returns viewport coordinates; translate for the positioned parent.
    panel.style.transform = 'none';
    var parent = panel.offsetParent;
    var parentRect = parent && parent !== doc.body && parent !== doc.documentElement ? parent.getBoundingClientRect() : { left: 0, top: 0 };
    if (root.getComputedStyle(panel).position === 'fixed') parentRect = { left: 0, top: 0 };
    panel.style.left = Math.round(best.left - parentRect.left + (parent ? parent.scrollLeft : 0)) + 'px';
    panel.style.top = Math.round(best.top - parentRect.top + (parent ? parent.scrollTop : 0)) + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    if (target) panel.style.setProperty('--arrow-top', Math.round(clamp(target.top + target.height / 2 - best.top, 18, height - 18)) + 'px');
    return { left: best.left, top: best.top, right: best.right, bottom: best.bottom, overlap: bestScore };
  }
  function chatIdentity(name, avatarUrl) {
    var head = byId('chatopt-head');
    if (!head) return;
    var heading = byId('ui-chat-heading');
    if (!heading) {
      var original = head.firstElementChild;
      heading = doc.createElement('div'); heading.id = 'ui-chat-heading'; heading.className = 'ui-chat-heading';
      var avatar = doc.createElement('span'); avatar.id = 'ui-chat-avatar'; avatar.className = 'ui-chat-avatar'; avatar.setAttribute('aria-hidden', 'true');
      var labels = doc.createElement('div'); labels.className = 'ui-chat-heading-text';
      var title = doc.createElement('div'); title.className = 'ui-chat-title'; title.textContent = 'Chat options';
      var identity = doc.createElement('div'); identity.id = 'ui-chat-name'; identity.className = 'ui-chat-name';
      labels.appendChild(title); labels.appendChild(identity); heading.appendChild(avatar); heading.appendChild(labels);
      if (original && original.tagName === 'SPAN') head.replaceChild(heading, original);
      else head.insertBefore(heading, head.firstChild);
    }
    name = String(name || 'Current streamer');
    var nameNode = byId('ui-chat-name'), avatarNode = byId('ui-chat-avatar');
    if (nameNode.textContent !== name) nameNode.textContent = name;
    var url = String(avatarUrl || '');
    var currentUrl = avatarNode.getAttribute('data-avatar-url') || '';
    if (currentUrl !== url) {
      if (root.UIImages && root.UIImages.release) root.UIImages.release(avatarNode);
      avatarNode.setAttribute('data-avatar-url', url);
      avatarNode.style.backgroundImage = '';
      avatarNode.textContent = name.charAt(0).toUpperCase();
      if (url && root.UIImages && root.UIImages.watch) root.UIImages.watch(avatarNode, url, name);
    } else if (!url) avatarNode.textContent = name.charAt(0).toUpperCase();
  }
  function refreshIdentity() {
    if (!root.state) return;
    var slug = typeof root.chatStreamerSlug === 'function' ? root.chatStreamerSlug() : root.state.current;
    var channel = root.state.channels && root.state.channels[slug];
    var vod = root.state.vod;
    if (slug) chatIdentity((channel && channel.name) || (vod && vod.slug === slug && vod.name) || slug, channel && channel.avatar);
  }
  function apply(force) {
    if (!doc.body) return;
    var preferences = value();
    var large = preferences.uiText === 'large';
    if (!force && appliedText === large) return false;
    appliedText = large;
    doc.body.classList.toggle('ui-text-large', large);
    refreshIdentity();
    for (var i = 0; i < panelIds.length; i++) {
      var panel = byId(panelIds[i]);
      if (panel && panel.offsetWidth && panel.offsetHeight) place(panel);
    }
    if (detailAnchor && visible(byId('ui-details'))) place(byId('ui-details'), detailAnchor);
    return true;
  }
  function cancelDetails() {
    root.clearTimeout(detailTimer); detailTimer = null;
    if (detailObserver) detailObserver.disconnect();
    detailScrolls = [];
    if (detailAnchor) {
      if (oldDescription === null) detailAnchor.removeAttribute('aria-describedby');
      else detailAnchor.setAttribute('aria-describedby', oldDescription);
    }
    detailAnchor = null; detailKey = ''; oldDescription = null;
    var panel = byId('ui-details');
    if (panel) panel.classList.add('hidden');
  }
  function watchDetailAnchor(anchor) {
    if (!detailObserver && root.MutationObserver) detailObserver = new root.MutationObserver(function () {
      if (detailAnchor && !doc.documentElement.contains(detailAnchor)) cancelDetails();
    });
    // Watch only direct children along this anchor's path, while details are
    // pending or visible. Chat updates and unrelated subtrees do not trigger it.
    for (var parent = anchor.parentNode; parent; parent = parent.parentNode) {
      if (detailObserver) detailObserver.observe(parent, { childList: true });
      detailScrolls.push({ node: parent, top: parent.scrollTop || 0, left: parent.scrollLeft || 0 });
    }
  }
  function detailText(kind, item) {
    var channel = item.channel || {}, user = channel.user || {};
    var title = item.session_title || item.title || item.name || user.username || item.slug || 'Untitled';
    var meta = [];
    var name = item.name || user.username || channel.slug || item.slug;
    if (name && name !== title) meta.push(name);
    var category = item.category || (item.categories && item.categories[0] && item.categories[0].name);
    if (category && typeof category === 'object') category = category.name;
    if (category && category !== title) meta.push(category);
    if (kind === 'vod' && item.created_at) {
      var date = new Date(item.created_at);
      if (!isNaN(date.getTime())) meta.push(date.toLocaleDateString());
    }
    return { title: String(title), meta: meta.join(' · ') };
  }
  function details(kind, item, anchor) {
    if (kind === 'vod' || !anchor || !item) { cancelDetails(); return; }
    var content = detailText(kind, item);
    var key = kind + ':' + (item.id || item.uuid || item.slug || '') + ':' + content.title + ':' + content.meta;
    if (detailAnchor === anchor && detailKey === key) return;
    cancelDetails();
    detailAnchor = anchor; detailKey = key; oldDescription = anchor.getAttribute('aria-describedby');
    watchDetailAnchor(anchor);
    detailTimer = root.setTimeout(function () {
      detailTimer = null;
      if (detailAnchor !== anchor || !visible(anchor)) { cancelDetails(); return; }
      var rect = anchor.getBoundingClientRect(), view = viewport();
      if (rect.bottom <= 0 || rect.top >= view.height || rect.right <= 0 || rect.left >= view.width) { cancelDetails(); return; }
      var panel = byId('ui-details');
      if (!panel) {
        panel = doc.createElement('div'); panel.id = 'ui-details'; panel.setAttribute('role', 'tooltip');
        var title = doc.createElement('div'); title.className = 'ui-details-title';
        var meta = doc.createElement('div'); meta.className = 'ui-details-meta';
        panel.appendChild(title); panel.appendChild(meta); doc.body.appendChild(panel);
      }
      panel.children[0].textContent = content.title; panel.children[1].textContent = content.meta;
      panel.style.filter = typeof root.popupDimFilter === 'function' ? root.popupDimFilter() : '';
      panel.className = ''; panel.scrollTop = 0;
      anchor.setAttribute('aria-describedby', (oldDescription ? oldDescription + ' ' : '') + 'ui-details');
      place(panel, anchor);
    }, dwell);
  }
  function init() {
    if (initialized) { apply(); return; }
    initialized = true;
    root.addEventListener('resize', function () { cancelDetails(); apply(true); });
    doc.addEventListener('pointerdown', cancelDetails, true);
    doc.addEventListener('scroll', function (event) {
      var target = event.target;
      if (!detailAnchor) return;
      if (target === doc) target = doc.scrollingElement || doc.documentElement;
      for (var i = 0; i < detailScrolls.length; i++) {
        var saved = detailScrolls[i];
        if (saved.node !== target) continue;
        // Focus may have already scrolled before requesting these details.
        // Ignore that queued event; dismiss only when the position changes again.
        if (saved.top !== target.scrollTop || saved.left !== target.scrollLeft) cancelDetails();
        return;
      }
    }, true);
    apply();
  }
  root.UIPolish = { init: init, apply: apply, details: details, cancelDetails: cancelDetails, place: place, chatIdentity: chatIdentity };
}(window));
