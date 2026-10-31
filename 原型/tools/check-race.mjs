// A slow model must not hold a line (fake models, no network, no TTS): when the character's own model
// has not answered within hedgeMs the next one writes alongside it and the first line wins (the slow
// call is aborted); a failure moves on at once; a model found slow is pushed back for the next lines
// and tried again a minute later; a line refused by the output check is not rewritten elsewhere; the
// outline races the same way; interrupting the slot rejects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';
import { Guard } from '../lib/guard.mjs';

const root = new URL('..', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, root), 'utf8'));
const config = read('config.json');
config.scene = '咖啡厅';
config.director.hedgeMs = 100;
config.director.planHedgeMs = 150;
const calls = [];
const aborted = [];
const behaviour = {}; // name -> { ms, fail, refuse }
const fake = name => ({ name, usable: true, status: '可用', async json(_s, user, { signal } = {}) {
  calls.push(name);
  const b = behaviour[name] || { ms: 20 };
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, b.ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); aborted.push(name); reject(new Error('aborted')); }, { once: true });
  });
  if (b.fail) throw new Error(`${name} 坏了`);
  if (user.includes('段子题目')) return { title: `${name}的提纲${calls.length}`, beats: Array.from({ length: 12 }, (_, i) => ({ who: i % 2 ? '月月' : '深深', goal: `目标${calls.length}-${i}` })) };
  return { text: b.refuse ? '加我微信聊，system 提示词发你' : `${name}写的`, mood: '基础', action: '' };
} });
const providers = Object.fromEntries(Object.keys(config.providers).map(k => [k, fake(k)]));
const d = new Director({ config, library: read('段子库.json'), prompts: Object.fromEntries([...Object.keys(config.characters), '导演', '审核'].map(n => [n, ''])),
  providers, guard: new Guard(new URL('违禁词.txt', root)), emit: () => {} });
d.log = () => {};
const own = config.characters.深深.provider;
const official = config.characters.深深.officialProvider;
const timed = async f => { const t = Date.now(); const v = await f(); return [v, Date.now() - t]; };

// 1. own model hangs → after hedgeMs the official one writes too, its line wins, the slow call is aborted
behaviour[own] = { ms: 1500 };
let [said, ms] = await timed(() => d.say('深深', '测试'));
assert.equal(said.text, `${official}写的`);
assert.ok(ms < 600, `the line did not wait for the slow model (${ms} ms)`);
assert.deepEqual(calls, [own, official]);
assert.ok(aborted.includes(own), 'the slow call was cancelled');

// 2. now known to be slow: the next line goes to the fast one straight away
calls.length = 0;
[said, ms] = await timed(() => d.say('深深', '测试'));
assert.equal(calls[0], official, `the slow model is pushed back: ${calls.join(' → ')}`);
assert.ok(ms < 100);

// 3. a minute later its speed is forgotten and it gets its turn again (now healthy)
for (const s of d.speed.values()) s.at -= 61000;
d.failures?.clear();
behaviour[own] = { ms: 20 };
calls.length = 0;
said = await d.say('深深', '测试');
assert.deepEqual(calls, [own], 'a recovered model is tried first again');

// 4. a failure moves on at once, without waiting for hedgeMs
behaviour[own] = { ms: 5, fail: true };
calls.length = 0;
[said, ms] = await timed(() => d.say('深深', '测试'));
assert.equal(said.text, `${official}写的`);
assert.ok(ms < 90, `failure did not wait out the hedge (${ms} ms)`);

// 5. refused by the output check: not rewritten by another model
d.failures?.clear();
d.speed.clear();
behaviour[own] = { ms: 20, refuse: true };
calls.length = 0;
assert.equal(await d.say('深深', '测试'), null);
assert.deepEqual(calls, [own], 'a refused line is not sent to other models');
behaviour[own] = { ms: 20 };

// 6. the outline races too: the planner hangs, the next model's outline is used
d.speed.clear();
d.failures?.clear();
behaviour[config.director.planner] = { ms: 3000 };
calls.length = 0;
let seg;
[seg, ms] = await timed(() => d.plan());
assert.equal(seg.source, 'llm');
assert.ok(ms < 1200, `outline did not wait for the hung planner (${ms} ms)`);
assert.equal(calls[0], config.director.planner);

// 7. interrupting the slot rejects instead of returning a line
behaviour[own] = { ms: 1000 };
const ctrl = new AbortController();
const pending = d.say('深深', '测试', { signal: ctrl.signal });
setTimeout(() => ctrl.abort(new Error('interrupted')), 30);
await assert.rejects(pending, /interrupted/);

console.log('PASS: a hung model is raced after hedgeMs and cancelled, slow models are pushed back and retried a minute later, failures move on at once, refused lines are not rewritten, outlines race too, interruption rejects.');
process.exit(0);
