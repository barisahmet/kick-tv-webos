'use strict';
/* 7TV emotes. Many Kick chats use this third-party emote set: Kick itself sends
   those emotes as plain words ("GAMBA") and each viewer's side swaps in the picture,
   from the channel's own set or the global one. Without this they read as noise.

   The service fetches a set and boils it down to [name, id] pairs (the raw answer
   is megabytes for a big channel). Sets are looked up by the channel owner's Kick
   user id, and a few are kept in memory so hopping back to a channel is free. */
var SEVENTV_CDN = 'https://cdn.7tv.app/emote/';
var SEVENTV_KEEP = 4;                  // channel sets kept, besides the global one
var SEVENTV_RETRY_MS = 5 * 60000;      // a failed lookup is not repeated before this
// sets: 'global' or a user id -> { name: id } (no prototype, so "constructor" is just a word).
var sevenTv = { current: '', sets: Object.create(null), order: [],
                loading: Object.create(null), failedAt: Object.create(null) };
function chatOwnerId() {
  var slug = state.current || (state.vod && state.vod.slug);
  var c = slug && state.channels[slug];
  return c && c.userId > 0 ? c.userId : 0;
}
function storeSevenTvSet(key, pairs) {
  var map = Object.create(null);
  if (Array.isArray(pairs)) {
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') map[p[0]] = p[1];
    }
  }
  sevenTv.sets[key] = map;
  if (key === 'global') return;
  sevenTv.order.push(key);
  for (var j = 0; sevenTv.order.length > SEVENTV_KEEP && j < sevenTv.order.length;) {
    if (sevenTv.order[j] === sevenTv.current) { j++; continue; }
    delete sevenTv.sets[sevenTv.order[j]];
    sevenTv.order.splice(j, 1);
  }
}
function loadSevenTvSet(key, payload) {
  if (sevenTv.sets[key] || sevenTv.loading[key]) return;
  if (sevenTv.failedAt[key] && Date.now() - sevenTv.failedAt[key] < SEVENTV_RETRY_MS) return;
  sevenTv.loading[key] = true;
  serviceRequest('sevenTv', payload, function (err, data) {
    delete sevenTv.loading[key];
    // 404: this channel has no 7TV. That is an answer, so remember it as an empty set.
    if (err && err !== 404) { sevenTv.failedAt[key] = Date.now(); return; }
    delete sevenTv.failedAt[key];
    storeSevenTvSet(key, err ? [] : (data && data.emotes));
    redrawChatPin();           // the pinned message may have been drawn before its emotes were known
  });
}
// Point the lookups at whoever's chat is open, fetching what is not in memory yet.
// Messages already on screen stay as they are; new ones pick the pictures up.
function useSevenTv() {
  var id = chatOwnerId();
  sevenTv.current = id ? String(id) : '';
  if (settings.chatEmotes === 'text') return;
  loadSevenTvSet('global', { global: true });
  if (!id) return;
  var at = sevenTv.order.indexOf(sevenTv.current);
  if (at !== -1) { sevenTv.order.splice(at, 1); sevenTv.order.push(sevenTv.current); }   // most recently used last
  loadSevenTvSet(sevenTv.current, { userId: id });
}
// Split message text into runs of plain text and 7TV emotes. Emotes are whole
// words, matched exactly; the text between them is kept as written.
function chatTextParts(text) {
  text = String(text || '');
  if (!text) return [];
  var own = sevenTv.current ? sevenTv.sets[sevenTv.current] : null, global = sevenTv.sets.global;
  if (!own && !global) return [{ text: text }];
  var parts = [], re = /\S+/g, last = 0, m;
  while ((m = re.exec(text)) !== null) {
    var id = (own && own[m[0]]) || (global && global[m[0]]);
    if (typeof id !== 'string') continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ emote: id, name: m[0] });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
