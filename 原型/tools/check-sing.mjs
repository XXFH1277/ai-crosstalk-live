// Singing gag (fake models, no TTS): a viewer request is reviewed, becomes a 'sing' job, and the
// job yields lead-in → recorded excerpt (4–8 s, faded) → 月月's reaction.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Director } from '../lib/director.mjs';
import { Guard } from '../lib/guard.mjs';

const root = new URL('..', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, root), 'utf8'));
const config = read('config.json');
config.scene = '咖啡厅'; // 深深 must be on stage to sing, whatever scene was last picked
// 清唱录音不随仓库分发：没有自己的录音时，生成一段 45 秒的测试音代替
if (!existsSync(new URL(`lib/../${config.director.sing.file}`, root))) {
  const rate = 16000, n = rate * 45, pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  mkdirSync(new URL('tmp/', root), { recursive: true });
  writeFileSync(new URL('tmp/清唱测试音.wav', root), Buffer.concat([h, pcm]));
  config.director.sing.file = 'tmp/清唱测试音.wav';
}
const fake = { name: 'fake', usable: true, async json(_s, user) {
  if (user.includes('待审核弹幕')) return { items: [{ i: 0, category: 'normal', score: 5 }] };
  return { text: user.includes('清唱一小段') ? '咳咳，本鲸开嗓了！' : '停停停，耳朵要报警了。', mood: '开心' };
} };
const d = new Director({ config, library: read('段子库.json'), prompts: { 深深: '', 月月: '', 审核: '' },
  providers: Object.fromEntries(Object.keys(config.providers).map(k => [k, fake])), guard: new Guard(new URL('违禁词.txt', root)), emit: () => {} });
d.log = () => {};
assert.ok(d.clip, 'recording loaded');

d.onEvent({ type: 'danmaku', user: '想听歌的观众', text: '深深唱一个' });
await d.reviewBatch();
assert.equal(d.singRequest, '想听歌的观众');
assert.equal(d.pickDanmaku(), null, 'the request is answered by the song, not by a separate reply');
d.lastSing = 0;
const job = await d.nextJob({ side: true, main: false });
assert.equal(job.kind, 'sing');
const drafts = await d.compose(d.reserve(job));
assert.deepEqual(drafts.map(x => x.who), ['深深', '深深', '月月']);
const line = await d.voice(drafts[1]);
assert.ok(line.seconds >= 3.9 && line.seconds <= 8.1, `excerpt ${line.seconds}s`);
const wav = d.audio.get(line.id);
const last = wav.readInt16LE(wav.length - 2);
assert.ok(Math.abs(last) < 200, 'fades out at the end');
mkdirSync(new URL('logs/', root), { recursive: true }); // logs/ is gitignored, so a fresh clone has no such folder
writeFileSync(new URL('logs/清唱试听.wav', root), wav);
console.log(`PASS: request → sing job → ${drafts.map(x => x.text).join(' / ')}；截取 ${line.seconds.toFixed(1)} 秒，已存 logs/清唱试听.wav`);
process.exit(0);
