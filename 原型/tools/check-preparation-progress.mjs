// Offline integration checks: real director + voicer + TTS code, mocked fetch/model boundaries.
// Run: node tools/check-preparation-progress.mjs
// Never contacts the application's server, real model providers or TTS service.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Director } from '../lib/director.mjs';

const endpoint = 'http://offline.invalid/synthesize';
const originalFetch = globalThis.fetch;
const names = ['深深', '月月'];

function makeDirector({ timeoutMs = 2000, providers = {} } = {}) {
  const config = {
    tts: { url: endpoint, timeoutMs, cfgScale: 1, seed: 1 },
    director: {
      planner: 'planner', lookahead: 2, historyLines: 16, maxLineChars: 45,
      danmakuEveryLines: 2, fillers: { enabled: false },
      gifts: { minLinesBetweenThanks: 2, batchSeconds: 40 },
    },
    characters: Object.fromEntries(names.map(name => [name, {
      provider: 'writer', voice: 'test-voice', directionPrefix: '', actions: {},
      moods: { 基础: { direction: 'test-only' } },
    }])),
  };
  const events = [];
  const director = new Director({
    config, providers, prompts: { 导演: 'offline planner fixture' },
    library: { segments: [] }, memes: null,
    guard: { checkOutput: () => null }, emit: event => events.push(event),
  });
  // Preserve diagnostic messages without noisy production console output.
  director.log = message => director.logs.push(message);
  return { director, events };
}

function pcmResponse() {
  return new Response(new Uint8Array(6000), {
    status: 200, headers: { 'x-sample-rate': '24000' },
  });
}

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function waitFor(predicate, message, timeoutMs = 1500) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await delay(5);
  }
}

function heldFetch(signal, held) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    held.promise.then(() => {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) resolve(pcmResponse());
    });
  });
}

async function scriptedSlot(director, who, text) {
  const beat = { who, text, mood: '基础' };
  const segment = { title: 'offline', source: 'script', pos: 0, beats: [beat] };
  const slot = director.reserve({ kind: 'beat', beat, beatIdx: 0, segment });
  assert.equal(director.snapshot().prepared.at(-1).status, '写作中');
  await director.write(slot);
  assert.equal(slot.written, true);
  assert(Number.isFinite(slot.createdAt) && Number.isFinite(slot.writtenAt));
  return slot;
}

async function checkPreparationStages() {
  const { director } = makeDirector();
  const first = await scriptedSlot(director, names[0], 'first offline line');
  const second = await scriptedSlot(director, names[1], 'second offline line');
  second.writtenAt -= 2500;
  assert.deepEqual(director.snapshot().prepared.map(row => row.status), ['等待配音', '等待配音']);
  assert(director.snapshot().prepared[1].waitSeconds >= 2);

  const holds = [gate(), gate()];
  const calls = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, endpoint, 'unexpected network target');
    const index = calls.length;
    calls.push(init.body.get('text'));
    assert(index < holds.length, 'unexpected extra synthesis');
    return heldFetch(init.signal, holds[index]);
  };
  director.running = true;
  const work = director.voicer();
  try {
    await waitFor(() => calls.length === 1, 'first synthesis did not start');
    assert.deepEqual(director.snapshot().prepared.map(row => row.status), ['配音中', '等待配音']);
    assert.equal(first.voicingIndex, 0);
    assert(Number.isFinite(first.voicingAt));

    holds[0].release();
    await waitFor(() => calls.length === 2, 'second synthesis did not start after first');
    assert.deepEqual(director.snapshot().prepared.map(row => row.status), ['已配音', '配音中']);
    assert.equal(director.snapshot().prepared[0].waitSeconds, 0);

    holds[1].release();
    await waitFor(() => second.voiced, 'second synthesis did not finish');
    assert.deepEqual(director.snapshot().prepared.map(row => row.status), ['已配音', '已配音']);
    assert.equal(second.voicingAt, null);
    assert.equal(second.voicingIndex, null);
    assert.equal(director.audio.size, 2);
    assert.deepEqual(calls, ['first offline line', 'second offline line']);
  } finally {
    holds.forEach(item => item.release());
    director.running = false;
    director.wake();
    await work;
  }
  console.log('PASS: actual voicer exposes queued -> synthesizing -> ready with elapsed time.');
}

async function checkTimeoutContinues() {
  const { director, events } = makeDirector({ timeoutMs: 40 });
  const failed = await scriptedSlot(director, names[0], 'timeout offline line');
  await scriptedSlot(director, names[1], 'surviving offline line');
  const never = gate();
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, endpoint, 'unexpected network target');
    calls++;
    if (calls === 1) return heldFetch(init.signal, never);
    return pcmResponse();
  };
  director.overlayReady = true;
  director.running = true;
  const work = director.voicer();
  try {
    await waitFor(() => events.some(event => event.type === 'line'), 'timeout did not let the next line play');
    const lines = events.filter(event => event.type === 'line');
    assert.equal(calls, 2);
    assert.equal(failed.voiced, true);
    assert.equal(failed.drafts.length, 0);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, 'surviving offline line');
    assert.equal(director.playing.id, lines[0].id);
    assert(director.logs.some(message => message.includes('配音失败，跳过这句')));
  } finally {
    never.release();
    director.running = false;
    director.wake();
    await work;
  }
  console.log('PASS: a real TTS timeout is skipped and the following line reaches playback.');
}

async function checkEarlierPrefetch() {
  const held = gate();
  let plannerCalls = 0;
  const beats = Array.from({ length: 12 }, (_, i) => ({ who: names[i % 2], goal: `goal ${i}` }));
  const { director } = makeDirector({ providers: {
    planner: { usable: true, status: 'offline mock', json: async () => {
      plannerCalls++;
      await held.promise;
      return { title: 'prefetched next segment', beats };
    } },
  } });
  globalThis.fetch = () => { throw new Error('prefetch must use the mocked model boundary'); };
  director.segment = { title: 'current segment', beats, pos: 0, source: 'llm' };
  for (let i = 0; i < 6; i++) {
    const job = await director.nextJob({ side: false, main: true });
    assert.equal(job.beatIdx, i);
    assert.equal(plannerCalls, 0, 'prefetch started before the halfway threshold');
  }
  const middle = await director.nextJob({ side: false, main: true });
  assert.equal(middle.beatIdx, 6);
  assert.equal(plannerCalls, 1, 'halfway point should start the next outline');
  for (let i = 7; i < 12; i++) {
    const job = await director.nextJob({ side: false, main: true });
    assert.equal(job.beatIdx, i, 'pending outline should not block the current segment');
    assert.equal(plannerCalls, 1, 'only one prefetch should be running');
  }
  held.release();
  const next = await director.nextJob({ side: false, main: true });
  assert.equal(next.segment.title, 'prefetched next segment');
  assert.equal(next.beatIdx, 0);
  assert.equal(plannerCalls, 1, 'segment transition should reuse the prefetched outline');
  console.log('PASS: halfway prefetch runs once, leaves the current segment unblocked, and is reused.');
}

try {
  await checkPreparationStages();
  await checkTimeoutContinues();
  await checkEarlierPrefetch();
  console.log('Preparation progress checks passed. All fetch/model calls were mocked.');
} finally {
  globalThis.fetch = originalFetch;
}
