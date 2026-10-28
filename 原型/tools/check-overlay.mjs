// Offline checks: no server, model calls, audio hardware or real viewer events.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/overlay.js', import.meta.url), 'utf8');
function harness(search = '') {
  let now = 0, timerId = 0, played = 0;
  const timers = new Map(), requests = [], nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: { setProperty() {} }, dataset: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {} },
    });
    return nodes.get(id);
  };
  const box = vm.createContext({
    console, URLSearchParams, AbortSignal, innerWidth: 1920, innerHeight: 1080,
    location: { search }, performance: { now: () => now },
    document: { getElementById: node }, addEventListener() {}, window: {},
    fetch: (url, options) => {
      requests.push({ url, method: options?.method || 'GET' });
      // Hold startup at its config read; tests initialize local state explicitly.
      return url === '/api/config' ? new Promise(() => {}) : Promise.resolve({ ok: true });
    },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, at: now + delay }); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    EventSource: class { constructor() { throw new Error('Preview must not connect SSE'); } },
    AudioContext: class { constructor() { throw new Error('Preview must not open audio'); } },
    recordPlayback: () => { played++; return Promise.resolve(); },
  });
  vm.runInContext(source, box);
  return {
    box, requests,
    get played() { return played; },
    run: text => vm.runInContext(text, box),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
  };
}

const h = harness();
h.run(`cfg = { overlay: { lineGapMs: 500, poseSeconds: 2 }, playbackRate: 1,
  characters: { 深深: { color: '#fff', actions: {} }, 月月: { color: '#fff', actions: {} } } };
  chars.深深 = {}; chars.月月 = {};
  audio = { play: recordPlayback }; started = true;
  current = { id: 'first', who: '深深' };
  finish(current);
  queue.push({ id: 'second', who: '月月', text: '接话', seconds: 2, audio: '/audio/test.wav' });
  playNext();`);
assert.equal(h.played, 0, 'An immediately prepared SSE line must wait');
h.advance(499);
assert.equal(h.played, 0);
h.advance(1);
assert.equal(h.played, 1, 'The line should start once the half-second gap ends');
assert.equal(h.requests.filter(r => r.url === '/api/played').length, 1);
h.run('finish(null)');

const baseline = { overlayReady: true, replyDanmaku: true, mock: false, douyin: { roomId: '123456' }, prepared: [], segment: { source: 'script' } };
h.box.fixture = baseline;
assert.equal(h.run('describeStatus(fixture, false, null).title'), '正在演绎预设段子');
h.box.fixture = { ...baseline, segment: { source: 'llm' }, prepared: [{ kind: 'beat', status: '写作中' }] };
assert.equal(h.run('describeStatus(fixture, false, null).title'), 'AI 正在生成台词');
h.box.fixture = { ...baseline, replyDanmaku: false };
assert.equal(h.run('describeStatus(fixture, false, null).interaction'), '弹幕回应已暂停');
h.box.fixture = { ...baseline, mock: true };
assert.equal(h.run('describeStatus(fixture, false, null).interaction'), '本地模拟互动');
assert.equal(h.run('describeStatus(null, false, null).title'), '节目状态暂不可用');
assert.equal(h.run('describeStatus(fixture, true, null).source'), '预览');

const preview = harness('?preview=1&autostart=1');
await preview.run('autostart()');
await preview.run("document.getElementById('start-btn').onclick()");
assert.ok(preview.requests.every(r => r.method === 'GET'), 'Preview must not start the director');
console.log('PASS: prepared-line pacing, status labels, preview start protection');
