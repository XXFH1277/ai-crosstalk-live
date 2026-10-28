// Relay fails → that one line (or outline / review) goes to the official API; relay stays first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';
import { Guard } from '../lib/guard.mjs';

const root = new URL('..', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, root), 'utf8'));
const config = read('config.json');
const calls = [];
const provider = (name, fail) => ({ name, usable: true, async json(_s, user) {
  calls.push(name);
  if (fail) throw new Error('The operation was aborted due to timeout');
  if (user.includes('段子题目')) return { title: `官方提纲${calls.length}`, beats: Array.from({ length: 12 }, (_, i) => ({ who: i % 2 ? '月月' : '深深', goal: `目标${i}` })) };
  if (user.includes('待审核弹幕')) return { items: [{ i: 0, category: 'normal', score: 4 }] };
  return { text: `${name}写的`, mood: '基础', action: '' };
} });
const providers = { deepseek: provider('deepseek', true), kimi: provider('kimi', true), doubao: provider('doubao', true),
  deepseekOfficial: provider('deepseekOfficial'), volc: provider('volc') };
const d = new Director({ config, library: read('段子库.json'), prompts: Object.fromEntries([...Object.keys(config.characters), '导演', '审核'].map(n => [n, ''])),
  providers, guard: new Guard(new URL('违禁词.txt', root)), emit: () => {} });
d.log = () => {};

assert.equal((await d.say('深深', '测试')).text, 'deepseekOfficial写的');
assert.deepEqual(calls, ['deepseek', 'deepseekOfficial'], 'relay first, then official once');
calls.length = 0;
assert.equal((await d.say('豆姐', '测试')).text, 'volc写的', '豆姐 falls back to 火山');
calls.length = 0;
assert.equal((await d.plan()).source, 'llm', 'outline comes from the official API');
assert.deepEqual(calls, ['deepseek', 'deepseekOfficial']);

// two relay failures within a minute → the next line skips the relay and goes official first
calls.length = 0;
await d.say('深深', '测试');
assert.deepEqual(calls, ['deepseekOfficial'], 'a shaky relay is skipped for a minute');

// a minute later (or with a healthy relay) the relay is tried first again
d.failures.clear();
providers.deepseek = provider('deepseek', false);
calls.length = 0;
await d.say('深深', '测试');
assert.deepEqual(calls, ['deepseek']);
console.log('PASS: relay first; on failure the call goes to the official API; a relay failing twice in a minute is skipped for a minute.');
process.exit(0);
