// Offline regression: real ingestion + safety filter + director, with only time/API mocked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ingest } from '../lib/ingest.mjs';
import { Guard } from '../lib/guard.mjs';
import { Director } from '../lib/director.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const library = JSON.parse(readFileSync(new URL('../段子库.json', import.meta.url), 'utf8'));
const originalNow = Date.now;
let now = 1000000;
Date.now = () => now;
const shown = [];
const reviewer = { usable: true, json: async () => ({ items: [
  { i: 0, category: 'normal', score: 5 }, { i: 1, category: 'normal', score: 5 },
] }) };
const director = new Director({ config, library, prompts: {}, providers: { deepseek: reviewer },
  guard: new Guard(fileURLToPath(new URL('../违禁词.txt', import.meta.url))), emit: ev => shown.push(ev) });
const ingest = new Ingest({ onEvent: ev => director.onEvent(ev), dedupeMs: config.douyin.dedupeMs });
const send = (text, offset, source = 'extension', user = '测试观众') => {
  now = 1000000 + offset;
  ingest.push(source, { type: 'danmaku', user, text });
};

try {
  send('早点睡', 0);
  send('你们会回复评论吗', 1000);
  now += 21000;
  // Review now runs in the background; picking only takes reviewed comments (newest first on ties).
  await director.reviewBatch();
  director.linesSinceDanmaku = 99;
  const a = await director.nextJob({ side: true, main: false });
  director.linesSinceDanmaku = 99;
  const b = await director.nextJob({ side: true, main: false });
  assert.deepEqual([a.ev.text, b.ev.text].sort(), ['你们会回复评论吗', '早点睡'].sort());
  assert.equal(director.snapshot().pendingDanmaku, 0);

  // Delayed copies arrive after the 15-second transport window, in a different order.
  send('早点睡', 23001, 'douyinLive');
  send('你们会回复评论吗', 24001);
  assert.equal(director.snapshot().pendingDanmaku, 0, 'previously scheduled comments must not enter the reply queue again');
  assert.equal(shown.filter(ev => ev.type === 'danmaku').length, 2);

  // A real new question and a different viewer asking the same thing still get turns.
  send('咖啡喜欢热的还是冰的', 25000);
  send('早点睡', 26000, 'douyinLive', '另一位观众');
  assert.equal(director.snapshot().pendingDanmaku, 2);
  send('咖啡喜欢热的还是冰的', 42001, 'douyinLive');
  assert.equal(director.snapshot().pendingDanmaku, 2, 'a pending question also gets only one queue entry');
  now += 21000;
  await director.reviewBatch();
  director.linesSinceDanmaku = 99;
  const c = await director.nextJob({ side: true, main: false });
  director.linesSinceDanmaku = 99;
  const e = await director.nextJob({ side: true, main: false });
  assert.deepEqual(new Set([c.ev.text, e.ev.text]), new Set(['咖啡喜欢热的还是冰的', '早点睡']));

  // Advance through a complete script and let a gift interrupt the scheduled reply.
  for (let i = 0; i <= library.segments[0].lines.length; i++) {
    await director.nextJob({ side: false, main: true });
  }
  const slot = director.reserve(a);
  director.onEvent({ type: 'gift', user: '礼物观众', gift: '测试礼物', coins: 100, count: 1 });
  assert.equal(slot.abort.signal.aborted, false);
  send('早 点 睡', 70000, 'douyinLive');
  assert.equal(director.snapshot().pendingDanmaku, 0, 'normalised duplicates stay suppressed across segment changes and gifts');

  // After the finite cooldown, the viewer may ask their last real question again.
  send('咖啡喜欢热的还是冰的', 626000);
  assert.equal(director.snapshot().pendingDanmaku, 1, 'the cooldown must not become a permanent ban on the same question');

  const guard = new Guard(fileURLToPath(new URL('../违禁词.txt', import.meta.url)));
  assert.equal(guard.hardFilter('测试观众', '晚上好').ok, true);
  now += 1000;
  assert.equal(guard.hardFilter('测试观众', '晚上好').ok, false, 'short-window repeat filtering remains enabled');
  now += 21000;
  assert.equal(guard.hardFilter('测试观众', '晚上好').ok, true);
  for (const text of ['喜欢相声', '你们好', '我来听听']) assert.equal(guard.hardFilter('测试观众', text).ok, true);
  assert.equal(guard.hardFilter('测试观众', '再问一句').reason, '刷屏');
  console.log('PASS: delayed copies, segment changes, gifts, new questions, separate viewers and cooldown expiry. No live traffic or speech.');
} finally {
  Date.now = originalNow;
}
