// Gifts read from chat text (browser extension) can be typed by anyone: "送出 小心心 x9999".
// douyinLive online → only its gifts count. douyinLive down → extension gifts are still thanked
// (real ones must not be lost), but each as one small gift, so typing cannot set off big thanks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ingest } from '../lib/ingest.mjs';
import { Director } from '../lib/director.mjs';
import { Guard } from '../lib/guard.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const d = new Director({ config, prompts: {}, library: JSON.parse(readFileSync(new URL('../段子库.json', import.meta.url), 'utf8')), providers: {}, guard: new Guard(new URL('../违禁词.txt', import.meta.url)), emit: () => {} });
d.log = () => {};
let online = false;
const out = [];
const ingest = new Ingest({ onEvent: ev => { out.push(ev); d.onEvent(ev); }, giftFlushMs: 10, trustedOnline: () => online });
ingest.push('extension', { type: 'prices', prices: { 小心心: 1, 嘉年华: 3000 } });
const wait = () => new Promise(r => setTimeout(r, 30));

// douyinLive down: typed fakes become one small gift; a real gift missing from the gift bar list
// (fan-club light etc.) is still thanked
ingest.push('extension', { type: 'gift', user: 'PCVD-CK', gift: '小心心', count: 9999 });
ingest.push('extension', { type: 'gift', user: '想吃鱼了', gift: '嘉年华', count: 1 });
ingest.push('extension', { type: 'gift', user: '雪霁迟', gift: '粉丝团灯牌', count: 1 });
await wait();
assert.deepEqual(out.map(e => `${e.user}:${e.gift}x${e.count}@${e.coins}`), ['PCVD-CK:小心心x1@1', '想吃鱼了:嘉年华x1@1', '雪霁迟:粉丝团灯牌x1@1']);
assert.equal(d.gifts.big.length + d.gifts.medium.length, 0, 'nothing typed reaches big or medium thanks');
assert.equal(d.gifts.small.length, 3, 'all three are waiting for the combined thanks');

// the same fake typed again and again within the window: still one
ingest.push('extension', { type: 'gift', user: 'PCVD-CK', gift: '小心心', count: 9999 });
await wait();
assert.equal(out.length, 3);

// and they really get spoken: the next side job is the combined thanks naming all three
d.linesSinceThanks = 5;
d.lastBatchThanks = 0;
const job = await d.nextJob({ side: true, main: false });
assert.equal(job?.kind, 'giftBatch');
assert.deepEqual(job.gifts.map(g => g.user).sort(), ['PCVD-CK', '想吃鱼了', '雪霁迟'].sort());
const line = d.batchDraft(job.gifts, '月月');
assert.ok(/PCVD-CK|想吃鱼了|雪霁迟/.test(line.text), line.text);

// douyinLive online: extension gifts ignored, douyinLive's count at full value
online = true;
out.length = 0;
ingest.push('extension', { type: 'gift', user: '捣乱的', gift: '嘉年华', count: 999 });
ingest.push('douyinLive', { type: 'gift', user: '真大哥', gift: '嘉年华', coins: 3000, count: 1, final: true });
await wait();
assert.deepEqual(out.map(e => `${e.user}:${e.gift}x${e.count}@${e.coins}`), ['真大哥:嘉年华x1@3000']);
assert.equal(d.gifts.big.length, 1, 'a real big gift is still a big thanks');
console.log('PASS: typed gifts never become big; real gifts are still thanked when douyinLive is down; douyinLive online → only its gifts count.');
process.exit(0);
