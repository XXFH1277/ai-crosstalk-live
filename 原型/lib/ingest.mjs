// Merges viewer events from several sources (douyinLive service, browser extension, …) into one
// stream for the director, dropping the copies that arrive from more than one source.
//
//   danmaku  same user + same text, or the same text from another source, within `dedupeMs`
//            → one event
//   gift     combos arrive as many messages with a growing count; they are collected per
//            user + gift and emitted once, when the combo ends (or after `giftFlushMs` of quiet).
//            A later copy with a count no higher than what was already emitted is a duplicate;
//            a higher count emits only the difference.
//            Only `trusted` sources (douyinLive: gifts pushed by Douyin's server) are believed. The
//            browser extension reads gifts from chat text, and a viewer can type "送出 小心心 x9999":
//            while a trusted source is online its gifts are ignored; otherwise they still get
//            thanked, but as one small gift each, so typing cannot set off a big thanks.

const norm = s => String(s ?? '').replace(/[\s​-‍﻿]/g, '').toLowerCase();

export class Ingest {
  constructor({ onEvent, dedupeMs = 15000, giftFlushMs = 2500, trusted = ['douyinLive'], trustedOnline }) {
    this.trusted = new Set(trusted);
    // Whether a trusted source is connected now (douyinLive's WebSocket is open). Without it,
    // "has sent something in the last minute" stands in.
    this.trustedOnline = trustedOnline || (() => [...this.trusted].some(s => this.stats[s] && Date.now() - this.stats[s].lastAt < 60000));
    this.onEvent = onEvent;
    this.dedupeMs = dedupeMs;
    this.giftFlushMs = giftFlushMs;
    this.seen = new Map(); // danmaku key -> time
    this.gifts = new Map(); // user|gift -> { user, gift, coins, count, emitted, timer, at }
    this.stats = {}; // source -> { received, duplicates, lastAt }
    this.prices = {}; // gift name -> diamonds, learned from any source that knows them
  }

  stat(source) {
    return (this.stats[source] ||= { received: 0, duplicates: 0, lastAt: 0 });
  }

  push(source, ev) {
    const st = this.stat(source);
    st.received++;
    st.lastAt = Date.now();
    if (ev.type === 'danmaku') return this.danmaku(st, ev, source);
    if (ev.type === 'gift') {
      if (this.trusted.has(source)) return this.gift(st, ev);
      if (this.trustedOnline()) {
        st.rejectedGifts = (st.rejectedGifts || 0) + 1;
        return;
      }
      return this.gift(st, { ...ev, count: 1, coins: 0, unverified: true });
    }
    if (ev.type === 'prices') Object.assign(this.prices, ev.prices);
  }

  // A copy is the same user + text, or the same text arriving from a *different* source: the
  // browser page's names can carry badge text (fan-club level etc.) that douyinLive's don't, so
  // the names of one comment need not match across sources. Two viewers typing the same thing
  // on the same source still count twice.
  danmaku(st, ev, source) {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t.at > this.dedupeMs) this.seen.delete(k);
    const key = `${norm(ev.user)}|${norm(ev.text)}`;
    const textKey = `text|${norm(ev.text)}`;
    const sameText = this.seen.get(textKey);
    if (this.seen.has(key) || (sameText && sameText.source !== source)) {
      st.duplicates++;
      return;
    }
    this.seen.set(key, { at: now, source });
    this.seen.set(textKey, { at: now, source });
    this.onEvent({ type: 'danmaku', user: ev.user, text: ev.text });
  }

  gift(st, ev) {
    const user = norm(ev.user);
    // Same gift from "the same" sender: names match, or one contains the other (badge text again).
    let key = `${user}|${norm(ev.gift)}`;
    for (const [k, g] of this.gifts) {
      const u = norm(g.user);
      if (norm(g.gift) === norm(ev.gift) && u && user && (u.includes(user) || user.includes(u))) {
        key = k;
        break;
      }
    }
    const count = Math.max(1, Number(ev.count) || 1);
    if (ev.coins) this.prices[ev.gift] = Number(ev.coins);
    let g = this.gifts.get(key);
    if (g && Date.now() - g.at > this.dedupeMs) {
      clearTimeout(g.timer);
      g = null;
    }
    if (!g) {
      g = { user: ev.user, gift: ev.gift, count: 0, emitted: 0, timer: null, at: 0, unverified: !!ev.unverified };
      this.gifts.set(key, g);
    }
    if (count <= g.count) st.duplicates++;
    g.count = Math.max(g.count, count);
    g.at = Date.now();
    clearTimeout(g.timer);
    if (ev.final) this.flushGift(key);
    else g.timer = setTimeout(() => this.flushGift(key), this.giftFlushMs);
  }

  flushGift(key) {
    const g = this.gifts.get(key);
    if (!g || g.count <= g.emitted) return;
    const count = g.count - g.emitted;
    g.emitted = g.count;
    // Keep the record for `dedupeMs` so a late copy from the other source is recognised.
    g.timer = setTimeout(() => this.gifts.get(key) === g && this.gifts.delete(key), this.dedupeMs);
    // Unverified (read from chat text): valued at 1 whatever the gift bar says, so it stays small.
    this.onEvent({ type: 'gift', user: g.user, gift: g.gift, count, coins: g.unverified ? 1 : this.prices[g.gift] || 1 });
  }
}
