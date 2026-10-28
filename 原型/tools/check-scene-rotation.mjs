// Scene rotation (fake models, no TTS): one segment per scene in order, switched only between
// segments, outlines written for the scene they will be played in, manual switch respected.
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
  const three = user.includes('群口');
  const who = three ? ['深深', '豆姐', '月月'] : ['深深', '月月'];
  return { title: `段子${++n}`, beats: Array.from({ length: 12 }, (_, i) => ({ who: who[i % who.length], goal: `第${n}段目标${i}` })) };
} };
const providers = Object.fromEntries(Object.keys(config.providers).map(k => [k, fake]));
const d = new Director({ config, library: read('段子库.json'), prompts: Object.fromEntries([...Object.keys(config.characters), '导演', '审核'].map(k => [k, ''])),
  providers, guard: new Guard(new URL('违禁词.txt', root)), emit: () => {} });
d.log = () => {};

const seen = [];
for (let i = 0; i < 12 * 4; i++) {
  const job = await d.nextJob({ side: false, main: true });
  if (job.beatIdx === 0) seen.push(config.scene);
  // every beat is spoken by someone on stage in the scene that is showing
  assert.ok(d.cast().includes(job.beat.who), `${job.beat.who} is on stage in ${config.scene}`);
}
assert.deepEqual(seen, [...order, order[0]], 'one segment per scene, in order, then round again');

// manual switch: rotation carries on from the chosen scene
d.setScene(order[2]);
while ((await d.nextJob({ side: false, main: true })).beatIdx !== 0);
assert.equal(config.scene, order[2], 'an outline prefetched for another scene is dropped');
console.log(`PASS: scenes rotate ${seen.join(' → ')}, switched between segments, outlines fit the cast; manual switch respected.`);
process.exit(0);
