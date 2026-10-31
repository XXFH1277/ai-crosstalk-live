// 离线检查 mindcraft 配音台的台词清洗、配音队列、过时丢弃、播放确认和受击判断（假配音，不连 Breeze）。
import assert from 'node:assert/strict';
import { cleanLine, SpeechQueue, HealthWatch } from '../minecraft-mindcraft/speech.mjs';

assert.equal(cleanLine('本鲸来啦，看看这儿都有啥！!nearbyBlocks'), '本鲸来啦，看看这儿都有啥！');
assert.equal(cleanLine('(To YueyueBot) 月月你那边有云杉没？ !searchForBlock("spruce_log", 32)'), '月月你那边有云杉没？');
assert.equal(cleanLine('Picking up item!'), '');
assert.equal(cleanLine('Hunting rabbit!'), '');
assert.equal(cleanLine('*used collectBlocks*'), '');
assert.equal(cleanLine('满地雪和石头  *used collectBlocks*'), '满地雪和石头');
assert.equal(cleanLine('[LoginGuard] Disconnected: [object Object]'), '');
assert.equal([...cleanLine('啊'.repeat(80))].length, 60);

let t = 0;
const now = () => t, events = [], voiced = [];
const voice = async (who, text) => { voiced.push(text); return { url: '/audio/line-' + voiced.length + '.wav', seconds: 2 }; };
const q = new SpeechQueue({ voice, publish: e => events.push(e), now });

// 没开声音时只记录，不配音
q.hear('ShenshenBot', '你好！!nearbyBlocks');
await q.tick(true);
assert.equal(voiced.length, 0);
assert.equal(q.history.at(-1).status, '未开声音');

assert.throws(() => q.start('短'));
q.start('client-aaaa');
assert.throws(() => q.start('client-bbbb'), /另一页面/);

// 不认识的 bot、纯英文都不进队列
assert.equal(q.hear('Steve', '你好'), false);
assert.equal(q.hear('YueyueBot', 'Picking up item!'), false);

q.hear('ShenshenBot', '先砍树。');
q.hear('YueyueBot', '我去挖煤。');
await q.tick(true);                     // 配第一句
await q.tick(true);                     // 播第一句，配第二句
const first = events.find(e => e.type === 'speech');
assert.equal(first.who, '深深');
assert.equal(first.text, '先砍树。');
assert.equal(q.pending.id, first.id);

// 只有当前播放页的确认才算数
assert.equal(q.acknowledge('client-bbbb', first.id, 'played'), false);
assert.equal(q.acknowledge('client-aaaa', first.id, 'played'), true);
t += 400; q.heartbeat('client-aaaa');
await q.tick(true);
assert.equal(q.pending.who, '月月');

// 没拿到播放权就不播
q.acknowledge('client-aaaa', q.pending.id, 'played');
q.hear('ShenshenBot', '这句要等。');
t += 400; q.heartbeat('client-aaaa');
await q.tick(false);
await q.tick(false);
assert.equal(q.pending, null);
assert.equal(q.phase, '等相声台让出播放权');

// 等太久的句子丢掉
t += 30000; q.heartbeat('client-aaaa');
await q.tick(true);
assert.equal(q.ready.length, 0);
assert.ok(q.history.some(h => h.text === '这句要等。' && h.status === '过时，已跳过'));

// 积压太多时丢最早的
for (let i = 0; i < 6; i++) q.hear('YueyueBot', '第' + i + '句。');
assert.equal(q.waiting.length, 3);
assert.equal(q.waiting[0].text, '第3句。');

// 配音失败不卡死
const bad = new SpeechQueue({ voice: async () => { throw Error('Breeze 没开'); }, publish: () => {}, now });
bad.start('client-cccc'); bad.hear('ShenshenBot', '试试。'); await bad.tick(true);
assert.equal(bad.voicing, false);
assert.match(bad.phase, /配音暂不可用/);

// 播放页掉线 15 秒自动暂停
t += 16000;
await q.tick(true);
assert.equal(q.enabled, false);
assert.equal(q.phase, '播放页面离线，已暂停');

// 受击判断
const reactions = [], hw = new HealthWatch(e => reactions.push(e.reaction.kind), now);
hw.update('ShenshenBot', 20);
hw.update('ShenshenBot', 17); assert.deepEqual(reactions, ['hurt']);
hw.update('ShenshenBot', 15); assert.deepEqual(reactions, ['hurt']);   // 3 秒内不重复
t += 4000; hw.update('ShenshenBot', 5); assert.deepEqual(reactions, ['hurt', 'danger']);
hw.update('ShenshenBot', 0); assert.deepEqual(reactions, ['hurt', 'danger', 'death']);
t += 4000; hw.update('ShenshenBot', 20); assert.deepEqual(reactions, ['hurt', 'danger', 'death', 'recovered']);
hw.update('ShenshenBot', 19.5); assert.equal(reactions.length, 4);    // 掉半格不算受击

console.log('mindcraft 配音台离线检查通过');
