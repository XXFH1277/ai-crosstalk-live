// Breeze TTS: one request at a time (the server answers 409 while busy), returns a WAV buffer.
import { setTimeout as delay } from 'node:timers/promises';

let chain = Promise.resolve();

export function synthesize(cfg, { text, voice, instruction }) {
  const run = () => request(cfg, { text, voice, instruction });
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}

async function request(cfg, { text, voice, instruction }) {
  const signal = AbortSignal.timeout(cfg.timeoutMs ?? 30000);
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('text', text);
    form.append('voice_id', voice);
    form.append('instruction', instruction);
    form.append('cfg_scale', String(cfg.cfgScale));
    form.append('seed', String(cfg.seed));
    const res = await fetch(cfg.url, { method: 'POST', body: form, signal });
    if (res.status === 409 && attempt < 20) {
      await delay(500, undefined, { signal });
      continue;
    }
    if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const rate = parseInt(res.headers.get('x-sample-rate') || '24000', 10);
    const pcm = Buffer.from(await res.arrayBuffer());
    if (pcm.length < rate / 5) throw new Error('TTS 返回的音频太短');
    return { wav: wav(pcm, rate), seconds: pcm.length / 2 / rate };
  }
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function ttsHealthy(cfg) {
  try {
    const res = await fetch(new URL('/health', cfg.url), { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Breeze sometimes keeps going after a very short line: the words, a pause, then a burst of
// noise that sounds like a squeak at the end. `firstPhrase` keeps only what comes before the
// first long pause (for one-word interjections), unless that would be too short to hold all of
// `chars` (then the pause was part of the line). Every line gets trailing silence trimmed and a
// short fade so it never stops on a click.
export function trimTail({ wav, seconds }, { firstPhrase = false, chars = 0 } = {}) {
  const rate = wav.readUInt32LE(24);
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
  const win = Math.round(rate * 0.02);
  const loud = [];
  for (let s = 0; s + win <= pcm.length; s += win) {
    let e = 0;
    for (let k = s; k < s + win; k++) e += pcm[k] * pcm[k];
    loud.push(10 * Math.log10(e / win + 1) > 30);
  }
  let end = loud.lastIndexOf(true) + 1;
  if (firstPhrase) {
    const first = loud.indexOf(true);
    const gap = Math.round(0.4 / 0.02);
    for (let i = first, quiet = 0; first >= 0 && i < end; i++) {
      quiet = loud[i] ? 0 : quiet + 1;
      if (quiet >= gap) {
        if ((i - quiet + 1) * 0.02 - first * 0.02 >= chars * 0.12) end = i - quiet + 1;
        break;
      }
    }
  }
  if (end <= 0) return { wav, seconds };
  const keep = Math.min(pcm.length, end * win + Math.round(rate * 0.15));
  const out = pcm.slice(0, keep);
  const fade = Math.min(keep, Math.round(rate * 0.04));
  for (let i = 0; i < fade; i++) out[keep - 1 - i] = Math.round(out[keep - 1 - i] * i / fade);
  return { wav: withSize(wav.subarray(0, 44), Buffer.from(out.buffer)), seconds: keep / rate };
}

function withSize(header, data) {
  const h = Buffer.from(header);
  h.writeUInt32LE(36 + data.length, 4);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
