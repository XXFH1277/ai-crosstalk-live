// mindcraft 配音台（7862）：听 mindcraft 两人说话 → Breeze 配音 → 立绘口型画面。
// 动作和台词都由 mindcraft 决定；这里只负责“念出来、画出来”，以及和 7860 相声台交接播放权。
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { voice, prepareCues, audioDir, audioMemory, cues, playbackRate } from '../minecraft/services.mjs';
import { SpeechQueue, HealthWatch, names } from './speech.mjs';

const require = createRequire(new URL('../../工具/mindcraft/package.json', import.meta.url));
const { io } = require('socket.io-client');

const port = 7862, origin = `http://127.0.0.1:${port}`, instance = randomUUID();
const mindserverPort = Number(process.env.MINDSERVER_PORT) || 8091;
const clients = new Set(), events = [];
let cueStatus = '准备受击短音中', mindserver = '未连接 MindServer', states = {};

function publish(event) {
  event = { at: Date.now(), ...event };
  if (event.type !== 'speech') { events.push(event); if (events.length > 60) events.shift(); }
  for (const c of clients) c.write('data: ' + JSON.stringify(event) + '\n\n');
  if (event.type === 'line') console.log(`${event.who}：${event.text}（${event.status}）`);
}

const speech = new SpeechQueue({ voice, publish });
const health = new HealthWatch(publish);

// 和 7860 交接播放权：7860 在跑就等它让出；7860 没开就单独播放。
const handoff = {
  status: '未接管', canPlay: false, busy: false, nextAt: 0, held: false,
  async tick(want) {
    if (this.busy || Date.now() < this.nextAt || (!want && !this.held)) return;
    this.busy = true; this.nextAt = Date.now() + 3000;
    try {
      const r = await fetch('http://127.0.0.1:7860/api/game-audience', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: instance, release: !want, take: false }), signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw Object.assign(Error('相声台拒绝'), { refused: true });
      const data = await r.json();
      this.held = want; this.canPlay = want && !!data.ready;
      this.status = !want ? '已交还相声台' : data.ready ? '相声台已让出播放权' : '等相声台当前句说完';
    } catch (e) {
      const offline = !e.refused && /ECONNREFUSED|fetch failed/i.test(String(e.cause?.code || e.cause?.message || e.message));
      this.held = false; this.canPlay = want && offline;
      this.status = offline ? '相声台没开，单独播放' : '相声台暂时连不上，先不播';
    } finally { this.busy = false; }
  }
};

const socket = io(`http://localhost:${mindserverPort}`, { reconnectionDelay: 2000 });
socket.on('connect', () => { mindserver = 'MindServer 已连接'; socket.emit('listen-to-agents'); });
socket.on('disconnect', () => { mindserver = 'MindServer 断开，等待重连'; });
socket.on('connect_error', () => { mindserver = `连不上 MindServer（端口 ${mindserverPort}），请先启动 mindcraft`; });
socket.on('bot-output', (bot, message) => speech.hear(bot, message));
socket.on('state-update', s => {
  states = s || {};
  for (const [bot, st] of Object.entries(states)) health.update(bot, st?.gameplay?.health);
});

// 发给 mindcraft 的话按“玩家消息”处理；去掉 ! 避免被当成命令，下目标单独走 !goal。
function tell(bot, text) { socket.emit('send-message', bot, { from: 'YourMCName', message: text }); }
function goal(text) {
  const clean = String(text).replace(/["\\!\r\n]/g, ' ').trim();
  if (!clean || clean.length > 180) throw Error('目标为 1～180 字');
  for (const bot of Object.keys(names)) tell(bot, `!goal("${clean}")`);
}

function botView(bot) {
  const s = states[bot], g = s?.gameplay || {}, inv = s?.inventory?.counts || {};
  const top = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`);
  return { bot, who: names[bot], online: !!s && !s.error, health: g.health ?? null, food: g.hunger ?? null,
    position: g.position || null, action: String(s?.action?.current || '').replace(/^action:/, '') || null, inventory: top };
}
const snapshot = () => ({ instance, mindserver, handoff: handoff.status, cueStatus, cues, playbackRate,
  speech: speech.snapshot(), bots: Object.keys(names).map(botView), events: events.slice(-30) });

const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  try {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === 'http://' + h))) return json(res, 403, { error: '只允许本机同源请求' });
    if (req.method === 'GET') {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(await readFile(new URL('./index.html', import.meta.url))); }
      if (req.url === '/api/state') return json(res, 200, snapshot());
      if (req.url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(': 已连接\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
      if (/^\/audio\/(line-\d+|cue-[01]-(hurt|danger|death|recovered)-\d+)\.wav$/.test(req.url)) {
        const id = req.url.slice(7), buffer = audioMemory.get(id) || (id.startsWith('cue-') ? await readFile(new URL(id, audioDir)) : null);
        if (!buffer) return json(res, 404, { error: '声音已过期' });
        res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(buffer);
      }
      if (req.url.startsWith('/assets/')) {
        const name = decodeURIComponent(req.url.slice(8));
        if (!/^(深深|月月)-(基础|脸|脸-(嘴-(半张|张大)|表情-(惊讶|开心|无语|得意))|动作-(抱头|扶额))\.(png|json)$/.test(name)) return json(res, 404, {});
        const buffer = await readFile(new URL('../../素材/透明/' + name, import.meta.url));
        res.writeHead(200, { 'content-type': name.endsWith('.png') ? 'image/png' : 'application/json' }); return res.end(buffer);
      }
    }
    if (req.method !== 'POST' || req.url !== '/api/command') return json(res, 404, { error: '未找到' });
    if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
    let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4096) return json(res, 413, { error: '请求过大' }); }
    const data = JSON.parse(raw);
    switch (data?.action) {
      case 'start': if (cueStatus !== '短音已就绪') throw Error('短音未就绪，请确认 Breeze F16 已启动'); speech.start(data.client); break;
      case 'stop': speech.stop(); break;
      case 'heartbeat': speech.heartbeat(data.client); break;
      case 'ack': speech.acknowledge(data.client, data.id, data.status); break;
      case 'goal': goal(data.text); publish({ type: 'notice', text: '已给两人下目标：' + String(data.text).slice(0, 60) }); break;
      default: throw Error('未知动作');
    }
    json(res, 200, snapshot());
  } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message || '操作未完成' }); else res.end(); }
});

const timer = setInterval(() => { handoff.tick(speech.enabled); speech.tick(handoff.canPlay).catch(() => {}); }, 250);
server.listen(port, '127.0.0.1', () => console.log('mindcraft 配音台：' + origin));
prepareCues().then(() => { cueStatus = '短音已就绪'; publish({ type: 'notice', text: cueStatus }); })
  .catch(() => { cueStatus = '短音准备失败，请检查 Breeze F16 后重启配音台'; publish({ type: 'notice', text: cueStatus }); });

function shutdown() { clearInterval(timer); speech.stop(); handoff.tick(false).finally(() => { socket.close(); for (const c of clients) c.end(); server.close(); process.exit(0); }); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
