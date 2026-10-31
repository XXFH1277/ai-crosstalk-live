// Offline playback regression. No live service, model, speakers or real TTS calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';

const saved = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
saved.scene = '咖啡厅'; // the usual pair, whatever scene was last picked
const fixture = enabled => {
  const config = structuredClone(saved);
  config.director.fillers.enabled = enabled;
  const events = [];
  const d = new Director({ config, prompts: {}, library: {}, providers: {}, guard: {}, emit: ev => events.push(ev) });
  d.log = () => {};
  d.overlayReady = true;
  d.fillers = { 深深: [{ id: 'filler-a', who: '深深', text: '嘿嘿。', kind: 'filler' }],
    月月: [{ id: 'filler-b', who: '月月', text: '嗯？', kind: 'filler' }] };
  d.slots = [{ who: '月月', sent: 0, voiced: false, lines: [] }];
  return { d, events };
};

const { d, events } = fixture(false);
d.maybeFiller();
assert.equal(events.length, 0, 'waiting for a line must not insert a cached laugh or interjection when disabled');

// Even the callback left by the previous sentence cannot insert a filler.
const originalTimeout = globalThis.setTimeout;
const callbacks = [];
globalThis.setTimeout = (fn, ms) => { callbacks.push({ fn, ms }); return callbacks.length; };
try {
  d.playing = { id: 'finished', kind: 'beat' };
  d.onPlayed('finished');
  for (const { fn } of callbacks) fn();
  assert.equal(events.length, 0);
  const next = { id: 'normal', who: '月月', text: '这句正常接话。', kind: 'beat' };
  d.slots[0].lines.push(next);
  d.slots[0].voiced = true;
  d.sendNext();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'normal', 'normal dialogue starts as soon as it is available');
} finally {
  globalThis.setTimeout = originalTimeout;
}

// Disabled startup must not spend time generating unused interjections.
const originalFetch = globalThis.fetch;
let ttsCalls = 0;
globalThis.fetch = async () => {
  ttsCalls++;
  return new Response(Buffer.alloc(48000), { headers: { 'x-sample-rate': '24000' } });
};
try {
  const idle = fixture(false);
  await idle.d.prepareFillers();
  assert.equal(ttsCalls, 0);
} finally {
  globalThis.fetch = originalFetch;
}

// The optional feature can still be explicitly enabled later.
const enabled = fixture(true);
enabled.d.maybeFiller();
assert.equal(enabled.events[0].kind, 'filler');
assert.equal(saved.director.fillers.enabled, true, "fillers are on again since tails are trimmed (lib/tts.mjs trimTail)");
assert.equal(saved.overlay.lineGapMs, 500);
console.log('PASS: no automatic interjections or filler TTS when disabled; normal dialogue and 0.5s pacing retained.');
