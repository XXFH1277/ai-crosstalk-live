// Scene changes wait for the last segment to be spoken: the overlay hears of a new scene only
// with the new segment's first line (opening), and a segment's last line is marked closing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';
import { Guard } from '../lib/guard.mjs';

const root = new URL('..', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, root), 'utf8'));
const config = read('config.json');
const order = config.director.sceneRotation.order;
config.scene = order[0];
let n = 0;
const fake = { name: 'fake', usable: true, async json(_s, user) {
  if (!user.includes('段子题目')) return { text: '台词', mood: '基础', action: '' };
  const who = user.includes('群口') ? ['深深', '豆姐', '月月'] : ['深深', '月月'];
  return { title: `段子${++n}`, beats: Array.from({ length: 12 }, (_, i) => ({ who: who[i % who.length], goal: `第${n}段目标${i}` })) };
} };
const events = [];
const d = new Director({ config, library: read('段子库.json'), prompts: Object.fromEntries([...Object.keys(config.characters), '导演', '审核'].map(k => [k, ''])),
  providers: Object.fromEntries(Object.keys(config.providers).map(k => [k, fake])), guard: new Guard(new URL('违禁词.txt', root)), emit: ev => events.push(ev) });
d.log = () => {};

const lines = [];
for (let i = 0; i < 24; i++) {
  const job = await d.nextJob({ side: false, main: true });
  lines.push({ ...d.draft({ ...job.beat, text: 'x', mood: '基础', kind: 'beat' }, job), id: String(i), audio: '', seconds: 1 });
}
// the writer moved on to the second scene while the first segment's lines are still unplayed
assert.equal(config.scene, order[1]);
assert.ok(!events.some(e => e.type === 'scene' || e.type === 'segment'), 'nothing told to the overlay early');

for (const line of lines) d.play(line);
const said = events.filter(e => e.type === 'line');
assert.deepEqual(said[0].opening, { title: '段子1', scene: order[0] }, 'show opens with curtain on the first scene');
assert.equal(said[11].closing, true, 'last line of segment 1 is the closing');
assert.deepEqual(said[12].opening, { title: '段子2', scene: order[1] }, 'scene changes with the first line of segment 2');
assert.ok(said.slice(1, 11).every(l => !l.opening && !l.closing));
console.log('PASS: scene change waits for the last segment; first line opens (curtain + title), last line closes.');
process.exit(0);
