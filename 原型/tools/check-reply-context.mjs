// Offline regression tests: mock model boundary, no server, network or TTS calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Director } from '../lib/director.mjs';

function fixture(providers = {}) {
  const character = { provider: 'primary', fallbackProvider: 'backup', moods: { 基础: {}, 轻快互动: {} }, actions: {} };
  const d = new Director({
    config: { director: { historyLines: 16, maxLineChars: 45 }, characters: { 深深: { ...character }, 月月: { ...character } } },
    prompts: { 深深: '角色设定', 月月: '角色设定' }, library: {}, providers,
    guard: { checkOutput: () => null, record() {} }, emit() {},
  });
  d.log = () => {};
  d.segment = { title: '睡前闹钟', beats: [{ who: '深深', goal: '接搭档的包袱并推进下一拍' }], pos: 0 };
  return d;
}

const capture = prompts => ({ usable: true, json: async (_system, user) => { prompts.push(user); return { text: '行，咱接着聊。', mood: '基础' }; } });
const line = (kind, text = '你手机设了几个闹钟？') => ({ id: `offline-${kind}`, who: '月月', text, kind });

test('played audience lines retain their type in history', () => {
  const d = fixture();
  d.play(line('danmaku'));
  d.play(line('invite'));
  assert.equal(d.history[0].kind, 'danmaku');
  assert.equal(d.history[1].kind, 'invite');
});

test('ordinary dialogue marks handled comments and past questions, forbidding a second answer', async () => {
  const d = fixture();
  d.history = [line('danmaku', '早点睡这句我听见啦。'), line('invite')];
  const prompts = [];
  await d.sayWith(capture(prompts), '深深', '推进下一拍', { segment: d.segment, beatIdx: 0 });
  assert.match(prompts[0], /已播.*观众评论已处理/);
  assert.match(prompts[0], /已播.*已向观众提问/);
  assert.match(prompts[0], /不要.*再次回答/);
  assert.match(prompts[0], /不要.*重复.*提问/);
  assert.match(prompts[0], /搭档.*接梗/);
});

test('pending audience reply before the current slot is marked as already assigned', async () => {
  const d = fixture();
  const abort = new AbortController();
  d.slots = [
    { abort: new AbortController(), drafts: [line('danmaku')], sent: 0 },
    { abort, drafts: null, sent: 0 },
  ];
  const prompts = [];
  await d.sayWith(capture(prompts), '深深', '推进下一拍', { segment: d.segment, beatIdx: 0, signal: abort.signal });
  assert.match(prompts[0], /已安排待播.*观众评论已处理/);
});

test('backup request keeps one context snapshot and excludes later-slot replies', async () => {
  const prompts = [];
  const abort = new AbortController();
  const d = fixture();
  const later = { abort: new AbortController(), drafts: null, sent: 0 };
  d.slots = [{ abort, drafts: null, sent: 0 }, later];
  d.providers = {
    primary: { usable: true, name: 'primary', json: async (_system, user) => {
      prompts.push(user);
      later.drafts = [line('danmaku', '后排评论答复：早睡这句我接住了。')];
      d.history.push(line('invite', '模型等待期间新增的观众问题'));
      throw new Error('offline simulated transient failure');
    } },
    backup: { ...capture(prompts), name: 'backup' },
  };
  await d.say('深深', '推进下一拍', { segment: d.segment, beatIdx: 0, signal: abort.signal });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1]);
  assert.doesNotMatch(prompts[1], /后排评论答复/);
});

test('audience reply keeps the light interaction style and still sees its current new comment', async () => {
  const d = fixture();
  const prompts = [];
  const answer = await d.sayWith(capture(prompts), '深深', '当前新评论：今天睡得好吗？', { interaction: true });
  assert.match(prompts[0], /当前新评论：今天睡得好吗/);
  assert.match(prompts[0], /可用语气（mood）：轻快互动/);
  assert.equal(answer.mood, '轻快互动');
});
