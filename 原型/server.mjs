// 鲸月咖啡厅 AI 相声直播 — local prototype server.
//   http://127.0.0.1:7860/          stream overlay (capture this window)
//   http://127.0.0.1:7860/control   mock danmaku / gifts and status
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Provider } from './lib/llm.mjs';
import { ttsHealthy } from './lib/tts.mjs';
import { Director } from './lib/director.mjs';
import { startMockAudience } from './lib/mock-audience.mjs';
import { Guard } from './lib/guard.mjs';
import { Ingest } from './lib/ingest.mjs';
import { DouyinLiveSource } from './lib/sources/douyinlive.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const ASSETS = join(ROOT, '..', '素材');

// API keys can live in .env.local (KEY=VALUE per line) instead of system environment variables.
if (existsSync(join(ROOT, '.env.local'))) {
  for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const library = JSON.parse(readFileSync(join(ROOT, '段子库.json'), 'utf8'));
const memes = existsSync(join(ROOT, '梗库.json')) ? JSON.parse(readFileSync(join(ROOT, '梗库.json'), 'utf8')) : null;
const prompts = Object.fromEntries([...Object.keys(config.characters), '导演', '审核'].map(n => [n, readFileSync(join(ROOT, 'prompts', `${n}.md`), 'utf8')]));
const guard = new Guard(join(ROOT, '违禁词.txt'));

const providers = Object.fromEntries(Object.entries(config.providers).map(([k, v]) => [k, new Provider(k, v)]));
await Promise.all(Object.values(providers).map(p => p.check()));
for (const p of Object.values(providers)) console.log(`API ${p.name}: ${p.status}`);
if (!(await ttsHealthy(config.tts))) console.log('警告：Breeze TTS 没有响应，请先运行 Breeze TTS 的启动脚本（见 tts-mac/ 或你自己的安装目录）');

const clients = new Set();
function emit(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

const director = new Director({ config, prompts, library, providers, emit, guard, memes });
mkdirSync(join(ROOT, 'logs'), { recursive: true });
director.loadMemory(join(ROOT, 'logs', '节目记录.json'));
director.logFile = join(ROOT, 'logs', `直播-${new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16)}.log`);
director.start();

// Real viewer events: two sources at once (douyinLive service + browser extension), merged and
// de-duplicated by Ingest before the director sees them.
const dy = config.douyin;
const ingest = new Ingest({ onEvent: ev => director.onEvent(ev), dedupeMs: dy.dedupeMs, giftFlushMs: dy.giftFlushMs, trustedOnline: () => douyinLive.online });
const douyinLive = new DouyinLiveSource({
  url: dy.douyinLive.url,
  key: process.env[dy.douyinLive.keyEnv],
  push: (source, ev) => ingest.push(source, ev),
  log: msg => director.log(msg),
});
if (dy.douyinLive.enabled) douyinLive.setRoom(dy.roomId);

function setRoom(roomId) {
  dy.roomId = roomId;
  writeFileSync(join(ROOT, 'config.json'), JSON.stringify(config, null, 2));
  if (dy.douyinLive.enabled) douyinLive.setRoom(roomId);
  director.log(roomId ? `抖音房间号设为 ${roomId}` : '已清空抖音房间号，停止接收真实弹幕');
}

const EVENT_TYPES = new Set(['danmaku', 'gift', 'prices', 'heartbeat']);

let stopMock = null;
let overlayAudio = '画面还没开演';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

async function sendFile(res, base, rel) {
  const path = normalize(join(base, rel));
  if (!path.startsWith(normalize(base))) return notFound(res);
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404).end('not found');
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  try {
    if (path === '/') return sendFile(res, join(ROOT, 'public'), 'overlay.html');
    if (path === '/control') return sendFile(res, join(ROOT, 'public'), 'control.html');
    if (path.startsWith('/public/')) return sendFile(res, join(ROOT, 'public'), path.slice(8));
    if (path.startsWith('/assets/')) return sendFile(res, ASSETS, path.slice(8));
    if (path === '/api/config') {
      const characters = Object.fromEntries(Object.entries(config.characters).map(([k, c]) => [k, { color: c.color, x: c.x, actions: c.actions || {} }]));
      return json(res, { characters, overlay: config.overlay, playbackRate: config.tts.playbackRate, scenes: config.scenes, scene: director.shownScene || config.scene });
    }
    if (req.method === 'POST' && path === '/api/scene') {
      if (!director.setScene(String((await body(req)).scene || ''))) return json(res, { error: '没有这个场景' }, 400);
      writeFileSync(join(ROOT, 'config.json'), JSON.stringify(config, null, 2));
      return json(res, { ok: true, scene: config.scene });
    }
    if (path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => {
        clients.delete(res);
        if (!clients.size) director.setOverlayReady(false);
      });
      return;
    }
    const audio = path.match(/^\/audio\/([\w-]+)\.wav$/);
    if (audio) {
      const wav = director.audio.get(audio[1]);
      if (!wav) return notFound(res);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      return res.end(wav);
    }
    if (req.method === 'POST' && path === '/api/ready') {
      director.setOverlayReady(true);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/overlay-audio') {
      overlayAudio = String((await body(req)).device || '').slice(0, 120);
      director.log(`直播画面声音输出到：${overlayAudio}`);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/played') {
      director.onPlayed((await body(req)).id);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/event') {
      const ev = await body(req);
      const user = String(ev.user || '匿名观众').slice(0, 20);
      if (ev.type === 'danmaku' && ev.text) director.onEvent({ type: 'danmaku', user, text: String(ev.text).slice(0, 60) });
      if (ev.type === 'gift') director.onEvent({ type: 'gift', user, gift: String(ev.gift), coins: Number(ev.coins) || 1, count: Number(ev.count) || 1 });
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/mock') {
      const { on } = await body(req);
      if (on && !stopMock) stopMock = startMockAudience(ev => director.onEvent(ev));
      if (!on && stopMock) { stopMock(); stopMock = null; }
      return json(res, { mock: !!stopMock });
    }
    if (path === '/api/douyin/config') return json(res, { roomId: dy.roomId });
    if (req.method === 'POST' && path === '/api/douyin') {
      const roomId = String((await body(req)).roomId || '').trim();
      if (roomId && !/^\d{6,20}$/.test(roomId)) return json(res, { error: '房间号应该是一串数字' }, 400);
      setRoom(roomId);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/ingest') {
      // From the browser extension. Everything here is viewer content: shape-checked, then it
      // goes through the same Guard as any other danmaku.
      const { source, events } = await body(req);
      for (const ev of (Array.isArray(events) ? events : []).slice(0, 100)) {
        if (!ev || !EVENT_TYPES.has(ev.type)) continue;
        const clean = {
          type: ev.type,
          user: String(ev.user ?? '').slice(0, 40),
          text: String(ev.text ?? '').slice(0, 200),
          gift: String(ev.gift ?? '').slice(0, 20),
          count: Math.min(9999, Math.max(1, Number(ev.count) || 1)),
          prices: ev.type === 'prices' && ev.prices && typeof ev.prices === 'object'
            ? Object.fromEntries(Object.entries(ev.prices).slice(0, 200).map(([k, v]) => [String(k).slice(0, 20), Number(v) || 0]))
            : undefined,
        };
        ingest.push(String(source || 'extension').slice(0, 20), clean);
      }
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/guard') {
      const { action, user, on } = await body(req);
      if (action === 'block' && user) guard.blockedUsers.add(String(user));
      if (action === 'unblock') guard.blockedUsers.delete(String(user));
      if (action === 'reload') guard.reload();
      if (action === 'replies') director.replyDanmaku = !!on;
      return json(res, { ok: true });
    }
    if (path === '/api/state') {
      return json(res, {
        ...director.snapshot(),
        mock: !!stopMock,
        replyDanmaku: director.replyDanmaku,
        scene: director.shownScene || config.scene,
        scenes: Object.keys(config.scenes || {}),
        blocked: guard.log.slice(-20).reverse(),
        blockedUsers: [...guard.blockedUsers],
        bannedWords: guard.words.length,
        overlayAudio,
        douyin: { roomId: dy.roomId, douyinLive: douyinLive.status, sources: ingest.stats, prices: Object.keys(ingest.prices).length },
      });
    }
    notFound(res);
  } catch (e) {
    console.error(e);
    json(res, { error: e.message }, 500);
  }
}).listen(config.port, '127.0.0.1', () => {
  console.log(`直播画面：http://127.0.0.1:${config.port}/`);
  console.log(`控制台：  http://127.0.0.1:${config.port}/control`);
});
