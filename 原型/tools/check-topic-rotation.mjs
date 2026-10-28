// Offline topic-planning tests. No live server, model, or TTS calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';

const library = JSON.parse(readFileSync(new URL('../段子库.json', import.meta.url), 'utf8'));
const outline = title => ({ title, beats: Array.from({ length: 10 }, (_, i) => ({ who: i % 2 ? '月月' : '深深', goal: `从第${i + 1}个具体细节推进生活误会，带出不同结果${i + 1}` })) });
function fixture(provider) {
  const d = new Director({ config: { director: { planner: 'test' } }, prompts: { 导演: 'offline prompt' }, library, providers: { test: provider }, guard: {}, emit() {} });
  d.log = () => {};
  return d;
}

test('forty local topics are selected before repeating; the first ten rotate categories', async () => {
  const topics = [];
  const categories = [];
  const d = fixture({ usable: true, json: async (_system, ask) => {
    topics.push(ask.match(/指定主题ID：([^\n]+)/)?.[1]);
    categories.push(ask.match(/题材分类：([^\n]+)/)?.[1]);
    return outline(`新节目${topics.length}`);
  } });
  for (let i = 0; i < 40; i++) assert.equal((await d.plan()).source, 'llm');
  assert.equal(new Set(topics).size, 40);
  assert.ok(topics.every(Boolean));
  assert.equal(new Set(categories.slice(0, 10)).size, 10);
  const firstForty = [...topics];
  await d.plan();
  assert.ok(!firstForty.slice(-12).includes(topics.at(-1)));
});

test('a normalized duplicate title is rejected without an unbounded model retry', async () => {
  let calls = 0;
  const d = fixture({ usable: true, json: async () => { calls++; return outline(calls === 1 ? '衣柜里的秘密' : ' 衣柜里的秘密！ '); } });
  assert.equal((await d.plan()).source, 'llm');
  assert.equal((await d.plan()).source, 'script');
  assert.equal(calls, 2);
});

test('short, single-speaker, and repeated-goal outlines fall back', async () => {
  const invalid = [
    { ...outline('太短'), beats: outline('x').beats.slice(0, 6) },
    { ...outline('独角戏'), beats: outline('x').beats.map(b => ({ ...b, who: '深深' })) },
    { ...outline('重复剧情'), beats: outline('x').beats.map(b => ({ ...b, goal: '继续讲同一个包袱' })) },
  ];
  for (const value of invalid) {
    let calls = 0;
    const d = fixture({ usable: true, json: async () => { calls++; return value; } });
    assert.equal((await d.plan()).source, 'script');
    assert.equal(calls, 1);
  }
});

test('fallback library has at least ten scripts, cycles without an early repeat, and records titles', async () => {
  assert.ok(library.segments.length >= 10);
  const d = fixture({ usable: false });
  const titles = [];
  for (let i = 0; i < library.segments.length; i++) {
    const p = await d.plan();
    assert.equal(p.source, 'script');
    titles.push(p.title);
    assert.ok(d.usedTitles.includes(p.title));
  }
  assert.equal(new Set(titles).size, library.segments.length);
  assert.equal((await d.plan()).title, titles[0]);
  for (let i = 0; i < 80; i++) await d.plan();
  assert.ok(d.usedTitles.length <= 32);
});

test('a planner exception selects one fallback and records its title', async () => {
  let calls = 0;
  const d = fixture({ usable: true, json: async () => { calls++; throw new Error('offline planner failure'); } });
  const p = await d.plan();
  assert.equal(p.source, 'script');
  assert.ok(d.usedTitles.includes(p.title));
  assert.equal(calls, 1);
});
