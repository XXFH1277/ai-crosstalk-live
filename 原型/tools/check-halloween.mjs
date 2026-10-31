// 万圣夜专场 (fake models, no TTS): picked from the control panel it rotates through seven two- and
// three-person line-ups of the four (万圣夜 ×2, then one segment each) and is not rotated back to the
// everyday scenes, not even when an outline fails; each scene only draws its own topic cards, written
// for whoever is on stage, and the everyday scenes never draw them; in the upright 万圣正头 picture set
// only the actions that set maps to its poses (plus plain motions) are offered.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';
import { Guard } from '../lib/guard.mjs';

const root = new URL('..', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, root), 'utf8'));
const config = read('config.json');
const topics = read('主题库.json').topics;
const halloween = new Set(topics.filter(t => t.scenes).map(t => t.id));
const SPECIAL = new Set(config.scenes['万圣夜'].rotation); // the special night's line-ups (宿舍夜话 too)
const cardScenes = Object.fromEntries(topics.filter(t => t.scenes).map(t => [t.id, t.scenes]));
assert.ok(halloween.size >= 12, 'there are 万圣夜 cards');
config.scene = '咖啡厅';
let n = 0;
const drawn = []; // [scene showing, topic id, cast written for] per outline
let failNext = false;
const fake = { name: 'fake', usable: true, async json(_s, user) {
  if (!user.includes('段子题目')) return { text: '台词', mood: '基础', action: '' };
  if (failNext) { failNext = false; throw new Error('假装导演超时'); }
  const on = user.match(/台上：(.+?)。/) || user.match(/两位角色(.+?)都参与/);
  const who = on ? on[1].split('、').map(x => x.replace(/（.*$/, '')) : ['深深', '月月'];
  drawn.push([config.scene, user.match(/指定主题ID：(\S+)/)[1], who]); // outlines are written ahead: who tells the scene
  return { title: `段子${++n}`, beats: Array.from({ length: 12 }, (_, i) => ({ who: who[i % who.length], goal: `第${n}段目标${i}` })) };
} };
const providers = Object.fromEntries(Object.keys(config.providers).map(k => [k, fake]));
const d = new Director({ config, library: read('段子库.json'), prompts: Object.fromEntries([...Object.keys(config.characters), '导演', '审核'].map(k => [k, ''])),
  providers, guard: new Guard(new URL('违禁词.txt', root)), emit: () => {} });
d.log = () => {};

// A switch from the control panel lets the segment on stage finish first (as on air).
async function finishCurrent() {
  let job;
  do job = await d.nextJob({ side: false, main: true }); while (job.beatIdx !== 0);
  return job;
}
async function segments(count, { first } = {}) {
  const seen = first ? [config.scene] : [];
  while (seen.length < count) {
    const job = await d.nextJob({ side: false, main: true });
    if (job.beatIdx === 0) seen.push(config.scene);
    assert.ok(d.cast().includes(job.beat.who), `${job.beat.who} is on stage in ${config.scene}`);
  }
  return seen;
}

// everyday rotation first: no 万圣夜 cards there
await segments(3);
d.setScene('万圣夜');
drawn.length = 0;
await finishCurrent();
const special = await segments(10, { first: true });
assert.deepEqual(special, ['万圣夜', '万圣夜', '万圣咖啡厅', '万圣书斋', '万圣夜·豆姐', '万圣咖啡厅·变装', '万圣夜·对口', '万圣夜·深克', '万圣书斋·变装', '宿舍夜话'], 'the special night keeps to its own rotation');
assert.deepEqual(d.cast('万圣夜'), ['深深', '小克', '月月'], 'the three kids are on stage');
assert.deepEqual(d.cast('万圣书斋'), ['小克', '月月'], '月月 and 小克 on their own');
const specialDraws = drawn.filter(([s]) => SPECIAL.has(s));
// Outlines are written a segment ahead, so the line-up they were written for tells their scene
// (two outfits of the same pair share a line-up).
const sameCast = (n, who) => SPECIAL.has(n) && d.cast(n).length === who.length && d.cast(n).every(x => who.includes(x));
assert.ok(specialDraws.length >= 9 && specialDraws.every(([, id, who]) => cardScenes[id]?.some(n => sameCast(n, who))), `each 万圣 line-up draws only its own cards: ${specialDraws.map(([, id, who]) => `${who.join('')}:${id}`).join(' ')}`);
const kidsCards = new Set(topics.filter(t => t.category === '万圣夜·三个孩子').map(t => t.id));
assert.ok(!specialDraws.some(([, id, who]) => !who.includes('小克') && kidsCards.has(id)), 'the three-kid cards need 小克 on stage');

// an outline that fails falls back to the library but stays in the special night
failNext = true;
const after = await segments(3);
assert.ok(after.every(s => SPECIAL.has(s)), `a failed outline does not leave 万圣夜: ${after.join(' → ')}`);

// upright picture set: its mapped poses offered, other outfits' poses not
d.setScene('万圣夜');
for (const [who, want] of [['深深', ['吓人', '害怕', '撒娇']], ['小克', ['喊卡', '傲娇', '害怕']], ['月月', ['摇扇', '害怕', '小本本']], ['豆姐', ['举杯', '展披风', '害怕']]]) {
  const acts = d.actionsFor(who);
  for (const a of want) assert.ok(acts[a]?.sets?.万圣正头, `${who} can ${a} in 万圣夜`);
  assert.ok(!Object.values(acts).some(a => a.pose && !a.sets?.万圣正头), `${who} has no other outfit's poses in 万圣夜`);
  for (const m of ['害怕', '惊呼', '撒娇', '傲娇']) assert.ok(config.characters[who].moods[m], `${who} can sound ${m}`);
}

// back to the everyday scenes from the control panel: no 万圣夜 cards, and the 万圣 poses are gone
d.setScene('咖啡厅');
await finishCurrent();
drawn.length = 0;
await segments(6, { first: true });
assert.ok(drawn.length && drawn.every(([s, id]) => !SPECIAL.has(s) && !halloween.has(id)), 'everyday scenes never draw 万圣夜 cards');
assert.ok(!d.actionsFor('深深').吓人 && !d.actionsFor('深深').撒娇?.pose, '万圣 poses only in the 万圣 scenes');
console.log(`PASS: 万圣夜 rotates ${special.join(' → ')}, draws only its ${halloween.size} cards, costume poses only in costume; everyday scenes untouched.`);
process.exit(0);
