// Read-only overlay preview. No models, TTS, viewer events or broadcast controls.
// Run: node tools/preview-overlay.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = resolve(root, 'public');
const assetRoot = resolve(root, '..', '素材');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/' && !url.searchParams.has('preview')) {
      res.writeHead(302, { Location: '/?preview=1' }).end(); return;
    }
    if (path === '/api/config') {
      const cfg = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
      const characters = Object.fromEntries(Object.entries(cfg.characters).map(([name, c]) => [name, { color: c.color, x: c.x, actions: c.actions || {} }]));
      res.writeHead(200, { 'Content-Type': types['.json'] });
      res.end(JSON.stringify({ characters, overlay: {}, playbackRate: cfg.tts.playbackRate })); return;
    }
    const base = path.startsWith('/assets/') ? assetRoot : publicRoot;
    const rel = path === '/' ? 'overlay.html' : path.startsWith('/assets/') ? path.slice(8) : path.startsWith('/public/') ? path.slice(8) : null;
    if (rel === null) { res.writeHead(404).end(); return; }
    const target = resolve(base, rel);
    if (!target.startsWith(base + sep)) { res.writeHead(404).end(); return; }
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404).end(); }
}).listen(7861, '127.0.0.1', () => console.log('Silent preview: http://127.0.0.1:7861/?preview=1'));
