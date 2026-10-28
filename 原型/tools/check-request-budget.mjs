// Exercise the real provider with a local mock HTTP boundary, never the live model.
import assert from 'node:assert/strict';
import { Provider } from '../lib/llm.mjs';
import { synthesize } from '../lib/tts.mjs';
const originalFetch = globalThis.fetch;
const signals = [];
let requests = 0;
globalThis.fetch = async (_url, options) => {
  signals.push(options.signal);
  requests++;
  return new Response(JSON.stringify({ choices: [{ message: {
    content: requests === 1 ? 'not json' : '{"text":"ok"}',
  } }] }), { status: 200 });
};
try {
  const provider = new Provider('offline', { baseUrl: 'http://unused.local', model: 'offline', apiKeyEnv: 'NO_TEST_KEY' });
  assert.equal((await provider.json('system', 'user', { timeoutMs: 20 })).text, 'ok');
  // The same overall deadline must remain attached even after a JSON-format retry.
  const unique = new Set(signals);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok([...unique].every(signal => signal.aborted));
  // Capture the common caller budget separately from each HTTP-attempt timeout.
  const calls = [];
  provider.jsonOnce = async (_s, _u, options) => {
    calls.push(options.signal);
    if (calls.length === 1) throw new SyntaxError('offline format error');
    return {};
  };
  await provider.json('system', 'user', { timeoutMs: 1000 });
  assert.ok(calls[0] instanceof AbortSignal, 'all JSON attempts need a shared overall deadline');
  assert.equal(calls[0], calls[1]);
  let ttsCalls = 0;
  globalThis.fetch = async () => ++ttsCalls === 1
    ? new Response('busy', { status: 409 })
    : new Response(Buffer.alloc(48000), { headers: { 'x-sample-rate': '24000' } });
  await assert.rejects(synthesize({ url: 'http://unused.local', cfgScale: 1.5, seed: 42, timeoutMs: 50 },
    { text: 'test', voice: 'offline', instruction: '' }), /abort|timeout/i,
  'TTS busy retries must share the total deadline instead of restarting it');
  assert.equal(ttsCalls, 1, 'an expired busy wait must not start another request');
  console.log('PASS: model retries and TTS busy waits respect their total request budgets. No real model or TTS calls.');
} finally {
  globalThis.fetch = originalFetch;
}
