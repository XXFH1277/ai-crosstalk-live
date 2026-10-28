// Load check (fake models and TTS, no network): heavy chat plus gifts for a few minutes.
// Checks that replies stay on recent comments, gifts are still thanked, and nothing is
// answered twice. Run:  node tools/check-load.mjs [seconds]
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';
import { Guard } from '../lib/guard.mjs';
import { Ingest } from '../lib/ingest.mjs';

const root = new URL('..', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, root), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const config = read('config.json');
const seconds = Number(process.argv[2] || 180);

const fake = name => ({
  name, usable: true, status: 'fake',
  async json(system, user) {
    await sleep(name === 'reviewer' ? 600 : 400);
    if (user.includes('待审核弹幕')) {
      const n = (user.match(/^\d+\. /gm) || []).length;
      return { items: Array.from({ length: n }, (_, i) => ({ i, category: 'normal', score: 4 })) };
    }
    if (user.includes('段子题目')) {
      return { title: `测试段子${Math.random().toString(36).slice(2, 6)}`, beats: Array.from({ length: 12 }, (_, i) => ({ who: i % 2 ? '月月' : '深深', goal: `第${i + 1}拍 ${Math.random()}` })) };
    }
    const asked = user.match(/原文是：「([^」]*)」/);
    return { text: asked ? `回复：${asked[1]}` : `正文${Math.random().toString(36).slice(2, 6)}`, mood: '基础', action: '' };
  },
});

const providers = { deepseek: fake('deepseek'), kimi: fake('kimi') };
const prompts = Object.fromEntries(['深深', '月月', '导演', '审核'].map(n => [n, '']));
const d = new Director({ config, prompts, library: read('段子库.json'), providers, guard: new Guard(new URL('违禁词.txt', root)), emit, memes: null });
d.log = () => {};
d.voice = async draft => {
  await sleep(250);
  return { ...draft, id: Math.random().toString(36).slice(2), audio: '', seconds: 1.5 };
};

const spoken = [];
function emit(ev) {
  if (ev.type !== 'line') return;
  spoken.push({ t: Date.now(), ...ev, askedAt: d.playing?.askedAt });
  setTimeout(() => d.onPlayed(ev.id), ev.seconds * 1000);
}

const ingest = new Ingest({ onEvent: ev => d.onEvent(ev), giftFlushMs: 1000 });
d.start();
d.setOverlayReady(true);

const t0 = Date.now();
let sent = 0;
let gifts = 0;
const timer = setInterval(() => {
  // three comments a second; each also arrives from the browser source with a badge in the name
  for (let k = 0; k < 3; k++) {
    const user = `观众${(sent % 200) + 1}`;
    const text = `第${sent}条弹幕`;
    ingest.push('douyinLive', { type: 'danmaku', user, text });
    if (Math.random() < 0.8) setTimeout(() => ingest.push('extension', { type: 'danmaku', user: `粉丝团3 ${user}`, text }), 1500);
    sent++;
  }
}, 1000);
const giftTimer = setInterval(() => {
  const big = gifts % 8 === 7;
  ingest.push('douyinLive', { type: 'gift', user: `送礼${gifts}`, gift: big ? '嘉年华' : '小心心', coins: big ? 3000 : 1, count: 1, final: true });
  gifts++;
}, 5000);

await sleep(seconds * 1000);
clearInterval(timer);
clearInterval(giftTimer);
d.running = false;

const replies = spoken.filter(l => l.kind === 'danmaku');
const ages = replies.map(l => (l.t - l.askedAt) / 1000).filter(Number.isFinite);
const third = Math.max(1, Math.floor(ages.length / 3));
const avg = a => (a.reduce((s, x) => s + x, 0) / (a.length || 1)).toFixed(1);
const texts = replies.map(l => l.text);
console.log(`时长 ${seconds}s，发出弹幕 ${sent} 条（约 80% 两路各一份），礼物 ${gifts} 个（大礼物 ${Math.floor(gifts / 8)} 个）`);
console.log(`共播 ${spoken.length} 句：正文 ${spoken.filter(l => l.kind === 'beat').length}，回弹幕 ${replies.length}，道谢 ${spoken.filter(l => l.kind === 'gift').length}`);
console.log(`回复的弹幕“发出到开口”：前 1/3 平均 ${avg(ages.slice(0, third))}s，最后 1/3 平均 ${avg(ages.slice(-third))}s，最长 ${Math.max(...ages).toFixed(1)}s`);
console.log(`重复回复：${texts.length - new Set(texts).size} 条`);
console.log(`还没谢的礼物：${JSON.stringify(d.snapshot().pendingGifts)}`);
process.exit(0);


