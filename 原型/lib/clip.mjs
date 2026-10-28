// Recorded audio gags (e.g. 深深's off-key a-cappella): play a random excerpt, not the whole file.
// Excerpts start at a phrase boundary, run `minSeconds`–`maxSeconds`, and fade out at the end.
import { readFileSync } from 'node:fs';

export class Clip {
  constructor(path, { phrases = [], minSeconds = 4, maxSeconds = 8, fadeSeconds = 0.5 } = {}) {
    const buf = readFileSync(path);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path} 不是 WAV 文件`);
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') {
        this.channels = buf.readUInt16LE(pos + 10);
        this.rate = buf.readUInt32LE(pos + 12);
        this.bits = buf.readUInt16LE(pos + 22);
      } else if (id === 'data') {
        this.pcm = buf.subarray(pos + 8, pos + 8 + size);
      }
      pos += 8 + size + (size % 2);
    }
    if (!this.pcm || this.bits !== 16) throw new Error(`${path} 需要是 16 位 PCM WAV`);
    this.frame = 2 * this.channels;
    this.seconds = this.pcm.length / this.frame / this.rate;
    this.phrases = phrases.length ? phrases : [[0, this.seconds]];
    Object.assign(this, { minSeconds, maxSeconds, fadeSeconds });
  }

  // A random excerpt as a WAV buffer: { wav, seconds }.
  excerpt() {
    const [start] = this.phrases[Math.floor(Math.random() * this.phrases.length)];
    const want = this.minSeconds + Math.random() * (this.maxSeconds - this.minSeconds);
    const end = Math.min(this.seconds, start + want);
    const a = Math.floor(start * this.rate) * this.frame;
    const b = Math.floor(end * this.rate) * this.frame;
    const pcm = Buffer.from(this.pcm.subarray(a, b));
    const n = pcm.length / 2;
    const fadeIn = Math.floor(0.03 * this.rate * this.channels);
    const fadeOut = Math.floor(this.fadeSeconds * this.rate * this.channels);
    for (let i = 0; i < n; i++) {
      const g = Math.min(1, i / fadeIn, (n - 1 - i) / fadeOut);
      if (g < 1) pcm.writeInt16LE(Math.round(pcm.readInt16LE(i * 2) * g), i * 2);
    }
    return { wav: wavFile(pcm, this.rate, this.channels), seconds: pcm.length / this.frame / this.rate };
  }
}

function wavFile(pcm, rate, channels) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2 * channels, 28); h.writeUInt16LE(2 * channels, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
