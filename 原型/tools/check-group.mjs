// 群口 (three on stage), fake models and TTS: outlines must give all three a part, side jobs go
// to whoever has been quiet longest, and reactions land on a listener.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';
import { Guard } from '../lib/guard.mjs';

const root = new URL('..', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, root), 'utf8'));
const config = read('config.json');
config.scene = '鲸云社·群口';
const cast = config.scenes[config.scene].cast;
const asks = [];
const fake = { name: 'fake', usable: true, async json(_s, user) {
  asks.push(user);
  if (user.includes('段子题目')) {
    const order = ['深深', '豆姐', '月月', '深深', '月月', '豆姐', '深深', '月月', '深深', '豆姐', '月月', '深深'];
    return { title: '群口测试', beats: order.map((who, i) => ({ who, goal: `第${i + 1}拍目标${i}` })) };
  }
  return { text: '测试台词', mood: '基础', action: '' };
} };
const d = new Director({ config, library: read('段子库.json'), prompts: Object.fromEntries([...cast, '导演', '审核'].map(n => [n, ''])),
  providers: { deepseek: fake, kimi: fake, doubao: fake }, guard: new Guard(new URL('违禁词.txt', root)), emit: () => {} });
d.log = () => {};

assert.deepEqual(d.cast(), ['深深', '豆姐', '月月']);
const seg = await d.plan();
assert.equal(seg.source, 'llm', 'a three-person outline is accepted');
assert.ok(asks.at(-1).includes('群口'), 'the planner is told it is 群口');

// two-person outline is rejected in 群口
asks.length = 0;
fake.json = async (_s, user) => (asks.push(user), user.includes('段子题目')
  ? { title: '只有两人', beats: Array.from({ length: 12 }, (_, i) => ({ who: i % 2 ? '月月' : '深深', goal: `目标${i}` })) }
  : { text: '台词', mood: '基础' });
assert.equal((await d.plan()).source, 'script', 'an outline leaving someone out falls back');

// quietest speaks next
d.history = [{ who: '豆姐', text: 'a' }, { who: '深深', text: 'b' }, { who: '月月', text: 'c' }];
assert.equal(d.nextSpeaker('月月'), '豆姐');
d.history.push({ who: '豆姐', text: 'd' });
assert.equal(d.nextSpeaker('豆姐'), '深深');

// reactions go to a listener; the speaker's prompt names everyone on stage
const reactors = new Set(Array.from({ length: 40 }, () => d.draft({ who: '深深', text: 'x', mood: '抛包袱', kind: 'beat' }).reactor));
assert.ok(!reactors.has('深深') && [...reactors].every(n => cast.includes(n)));
await d.say('豆姐', '这一句的任务：测试');
assert.ok(asks.at(-1).includes('豆姐（腻缝儿'), 'cast and roles are in the prompt');

// back to 对口: 豆姐 leaves
d.setScene('咖啡厅');
assert.deepEqual(d.cast(), ['深深', '月月']);
console.log('PASS: 群口 outlines need all three, quietest speaks next, reactions on listeners, cast in prompts; 对口 unchanged.');
process.exit(0);


