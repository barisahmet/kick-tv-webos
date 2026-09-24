/* Fixed-size catalogue window. Logical indexes never depend on mounted children. */
(function (root) {
  'use strict';
  /* The one rule for keeping a focused row in view, shared by every list and grid.
     A row that is visible, or only clipped by a sliver, is left alone: nudging the
     list for a few pixels made it jump under the viewer. Only a row that is mostly
     out of view scrolls in, and then just far enough to show it whole. Focus that
     came from the pointer never scrolls, since the row is already under it.
     Returns the scrollTop to use (unchanged means leave it). */
  function revealScroll(scroll, viewHeight, top, height, pad) {
    var ev = root.event;
    if (ev && /^(mouse|pointer)/.test(ev.type)) return scroll;
    var hidden = Math.max(0, scroll - top) + Math.max(0, top + height - (scroll + viewHeight));
    if (hidden <= Math.max(2, height / 3)) return scroll;
    if (top < scroll) return Math.max(0, top - (pad || 0));
    return top + height - viewHeight + (pad || 0);
  }
  root.revealScroll = revealScroll;
  function VirtualGrid(container, options) {
    this.container = container;
    this.options = options || {};
    this.items = [];
    this.nodes = {};
    this.keys = [];
    this.focused = -1;
    this.dirty = true;
    this.frame = null;
    this.content = document.createElement('div');
    this.content.className = 'virtual-grid-content';
    this.content.style.position = 'relative';
    this.content.style.width = '100%';
    container.innerHTML = '';
    container.style.display = 'block';
    container.style.position = 'relative';
    container.appendChild(this.content);
    var self = this;
    container.addEventListener('scroll', function () { self.schedule(); });
    if (root.ResizeObserver) {
      this.observer = new root.ResizeObserver(function () { self.dirty = true; self.schedule(); });
      this.observer.observe(container);
    }
    if (root.MutationObserver && document.body) {
      this.textObserver = new root.MutationObserver(function () { self.dirty = true; self.schedule(); });
      this.textObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    root.addEventListener('resize', function () { self.dirty = true; self.schedule(); });
  }
  VirtualGrid.prototype.schedule = function () {
    if (this.frame !== null) return;
    var self = this;
    this.frame = root.requestAnimationFrame(function () { self.frame = null; self.refresh(); });
  };
  VirtualGrid.prototype.setItems = function (items, key, create, update) {
    this.items = items || [];
    this.key = key;
    this.create = create;
    this.update = update;
    this.keys = [];
    for (var i = 0; i < this.items.length; i++) this.keys.push('$' + String(key(this.items[i], i)));
    this.refresh(true);
  };
  VirtualGrid.prototype.measure = function (sample) {
    if (!this.dirty && this.metrics) return;
    var style = root.getComputedStyle(this.container);
    var cardStyle = sample ? root.getComputedStyle(sample) : null;
    var margin = cardStyle ? (parseFloat(cardStyle.marginLeft) || 0) : 8;
    var width = sample ? sample.offsetWidth : (this.options.width || 408);
    var height = sample ? sample.offsetHeight : (this.options.height || 350);
    this.metrics = {
      cols: this.options.columns || 4,
      pitchX: width + margin * 2,
      pitchY: height + (cardStyle ? ((parseFloat(cardStyle.marginTop) || 0) + (parseFloat(cardStyle.marginBottom) || 0)) : 16),
      height: this.container.clientHeight || this.options.viewportHeight || 800,
      padding: parseFloat(style.paddingTop) || 0
    };
    this.dirty = false;
  };
  VirtualGrid.prototype.mount = function (i, updates) {
    var k = this.keys[i], node = this.nodes[k];
    if (!node) {
      node = this.create(this.items[i], i);
      node.style.position = 'absolute';
      this.nodes[k] = node;
      this.content.appendChild(node);
    } else if (updates && this.update) this.update(node, this.items[i], i);
    node.setAttribute('data-idx', i);
    node.setAttribute('data-grid-key', k.slice(1));
    return node;
  };
  VirtualGrid.prototype.refresh = function (updates) {
    var count = this.items.length, node, i;
    if (!this.container.clientWidth) { this.dirty = true; return; }
    if (!count) { this.removeOutside({}); this.content.style.height = '0px'; return; }
    if (this.dirty || !this.metrics) {
      var sample = null;
      for (var mounted in this.nodes) if (Object.prototype.hasOwnProperty.call(this.nodes, mounted)) { sample = this.nodes[mounted]; break; }
      if (!sample) sample = this.mount(Math.min(count - 1, Math.max(0, this.focused)), updates);
      this.measure(sample);
    }
    var m = this.metrics, rows = Math.ceil(count / m.cols);
    this.content.style.height = (rows * m.pitchY) + 'px';
    var maxTop = Math.max(0, rows * m.pitchY + m.padding * 2 - m.height);
    if (this.container.scrollTop > maxTop) this.container.scrollTop = maxTop;
    var overscan = this.options.overscan == null ? 1 : this.options.overscan;
    var firstRow = Math.max(0, Math.floor(this.container.scrollTop / m.pitchY) - overscan);
    var lastRow = Math.min(rows, Math.ceil((this.container.scrollTop + m.height) / m.pitchY) + overscan);
    var keep = {};
    for (i = firstRow * m.cols; i < Math.min(count, lastRow * m.cols); i++) {
      node = this.mount(i, updates);
      keep[this.keys[i]] = true;
      node.style.left = ((i % m.cols) * m.pitchX) + 'px';
      node.style.top = (Math.floor(i / m.cols) * m.pitchY) + 'px';
    }
    this.removeOutside(keep);
    if (root.UIImages) root.UIImages.scan(this.content);
    if (this.options.onRender) this.options.onRender(this);
  };
  VirtualGrid.prototype.removeOutside = function (keep) {
    for (var k in this.nodes) if (Object.prototype.hasOwnProperty.call(this.nodes, k) && !keep[k]) {
      var node = this.nodes[k];
      if (root.UIImages) root.UIImages.release(node);
      if (node.parentNode) node.parentNode.removeChild(node);
      delete this.nodes[k];
    }
  };
  VirtualGrid.prototype.focus = function (index) {
    if (!this.items.length) return null;
    index = Math.max(0, Math.min(this.items.length - 1, index));
    this.focused = index;
    if (!this.metrics || this.dirty) this.measure(this.mount(index, false));
    var m = this.metrics, top = Math.floor(index / m.cols) * m.pitchY;
    var visible = m.height - m.padding * 2;
    var scroll = this.container.scrollTop, next = revealScroll(scroll, visible, top, m.pitchY, 0);
    if (next !== scroll) this.container.scrollTop = next;
    this.refresh();
    return this.get(index);
  };
  VirtualGrid.prototype.get = function (index) { return this.nodes[this.keys[index]] || null; };
  VirtualGrid.prototype.clear = function () {
    this.items = []; this.keys = []; this.focused = -1;
    this.removeOutside({}); this.content.style.height = '0px'; this.container.scrollTop = 0;
  };
  root.VirtualGrid = VirtualGrid;
}(window));
