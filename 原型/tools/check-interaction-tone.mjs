// Offline regression for audience wording, mood selection and the TTS instruction path.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const library = JSON.parse(readFileSync(new URL('../段子库.json', import.meta.url), 'utf8'));
let capturedInstruction = '';
globalThis.fetch = async (_url, options) => {
  capturedInstruction = options.body.get('instruction');
  return new Response(Buffer.alloc(48000), { headers: { 'x-sample-rate': '24000' } });
};

for (const who of ['深深', '月月']) {
  const director = new Director({ config, prompts: {}, library, providers: {}, emit() {}, guard: { checkOutput: () => null }, memes: null });
  let task = '';
  director.say = async (_who, text, options) => {
    task = text;
    assert.equal(options.interaction, true);
    // Simulate the real failure: a friendly question gets an unrelated dramatic mood.
    return { text: '咖啡都打烊了，您老板还在续杯呢！', mood: who === '深深' ? '被拆穿' : '贯口', action: '' };
  };
  for (const kind of ['invite', 'danmaku']) {
    const slot = { who, abort: new AbortController(), job: { kind, ev: { user: '测试观众', text: '刚加完班' } } };
    const lines = await director.compose(slot);
    assert.equal(lines[0].mood, '轻快互动', `${who}/${kind} must keep the audience tone, not the model's unrelated dramatic mood`);
    assert.match(task, /相声/);
    await director.voice(lines[0]);
    assert.equal(capturedInstruction, config.characters[who].directionPrefix + config.characters[who].moods.轻快互动.direction);
    assert.doesNotMatch(capturedInstruction, /心虚慌张|最后一句故意大声打岔|越念越快/);
  }
  const mood = who === '深深' ? '抛包袱' : '吐槽';
  assert.equal(director.draft({ who, text: '原来的相声台词', mood, kind: 'beat' }).mood, mood);

  // Exercise model validation, not just the composition guard.
  let prompt = '';
  const provider = { json: async (_system, user) => {
    prompt = user;
    return { text: '咖啡还是零食，您选哪个？', mood };
  } };
  const audience = await director.sayWith(provider, who, '离线提问', { interaction: true });
  assert.equal(audience.mood, '轻快互动');
  assert.equal(prompt.split('\n').find(line => line.startsWith('可用语气')), '可用语气（mood）：轻快互动');
  const show = await director.sayWith(provider, who, '离线正文');
  assert.equal(show.mood, mood);
  assert.ok(!prompt.split('\n').find(line => line.startsWith('可用语气')).includes('轻快互动'));

  // API failures still use the same audience delivery; failed invitations stay silent.
  director.say = async () => null;
  for (const isAI of [false, true]) {
    const fallback = await director.compose({ who, abort: new AbortController(), job: {
      kind: 'danmaku', isAI, ev: { user: '测试观众', text: isAI ? '你是AI吗' : '晚上好' },
    } });
    assert.equal(fallback[0].mood, '轻快互动');
  }
  assert.deepEqual(await director.compose({ who, abort: new AbortController(), job: { kind: 'invite' } }), []);
}
assert.equal(config.overlay.lineGapMs, 500);
assert.equal(config.overlay.audioOutput, '');
console.log('PASS: both characters use lively audience tone; original show moods, 0.5s gap and system audio retained. No network calls.');
