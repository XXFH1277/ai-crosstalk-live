"""Re-sing a separated vocal track in a saved Breeze voice via /v1/audio/convert.

Usage: python sing_convert.py [--lines] <vocals.wav> <lyrics.srt> <voice_id> <out_dir> [keep ...]
Writes <out_dir>/<voice_id>-keep<N>.wav (24 kHz mono) for each keep_acoustic value.
With --lines each subtitle line is converted separately with its own lyric and
the pieces are stitched back together (<voice_id>-lines-keep<N>.wav).
"""
import array
import http.client
import re
import subprocess
import sys
import time
import uuid
import wave
from pathlib import Path


def srt_segments(path):
    def seconds(stamp):
        h, m, s = stamp.replace(',', '.').split(':')
        return int(h) * 3600 + int(m) * 60 + float(s)

    segments = []
    for block in Path(path).read_text(encoding='utf-8-sig').split('\n\n'):
        rows = [r.strip() for r in block.strip().splitlines()]
        if len(rows) >= 3 and '-->' in rows[1]:
            start, end = (seconds(part.strip()) for part in rows[1].split('-->'))
            segments.append((start, end, re.sub(r'\s+', '，', ' '.join(rows[2:]))))
    return segments


def srt_text(path):
    return '，'.join(text for _, _, text in srt_segments(path)) + '。'


def convert(source_wav, voice_id, text, keep, seed=42, port=8082):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (('voice_id', voice_id), ('text', text), ('keep_acoustic', str(keep)), ('seed', str(seed))):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="source"; filename="source.wav"\r\n'
                 f'Content-Type: audio/wav\r\n\r\n'.encode() + Path(source_wav).read_bytes() + b'\r\n')
    body = b''.join(parts) + f'--{boundary}--\r\n'.encode()
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3600)
    connection.request('POST', '/v1/audio/convert', body, {'Content-Type': f'multipart/form-data; boundary={boundary}'})
    response = connection.getresponse()
    data = response.read()
    if response.status != 200:
        raise SystemExit(f'convert failed: HTTP {response.status} {data[:300]!r}')
    return int(response.getheader('X-Sample-Rate', '24000')), data


def write_wav(path, rate, pcm):
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm)


def convert_lines(source, segments, voice_id, keep, work):
    """Convert one chunk per subtitle line; cut points sit midway through the gaps."""
    with wave.open(str(source)) as handle:
        rate = handle.getframerate()
        samples = array.array('h', handle.readframes(handle.getnframes()))
    cuts = [0]
    for (_, end, _), (start, _, _) in zip(segments, segments[1:]):
        cuts.append(int((end + start) / 2 * rate))
    cuts.append(len(samples))
    fade = int(0.015 * rate)
    result = array.array('h')
    for index, (_, _, text) in enumerate(segments):
        lo, hi = cuts[index], cuts[index + 1]
        chunk = work / f'line{index:02d}.wav'
        write_wav(chunk, rate, samples[lo:hi].tobytes())
        _, pcm = convert(chunk, voice_id, text + '。', keep)
        piece = array.array('h', pcm)
        # Converted length is rounded to codec frames; pin it to the source span.
        piece = piece[:hi - lo] + array.array('h', [0]) * max(0, hi - lo - len(piece))
        if result and fade:
            for i in range(fade):
                w = i / fade
                result[-fade + i] = int(result[-fade + i] * (1 - w) + piece[i] * w)
            piece = piece[fade:]
        result.extend(piece)
        print(f'  line {index + 1}/{len(segments)} done: {text}', flush=True)
    return rate, result.tobytes()


def main():
    args = sys.argv[1:]
    lines = '--lines' in args
    if lines:
        args.remove('--lines')
    vocals, lyrics, voice_id, out_dir = args[:4]
    keeps = [int(k) for k in args[4:]] or [0, 1, 2]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    source = out / 'vocals-24k.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', vocals, '-ac', '1', '-ar', '24000', '-sample_fmt', 's16', str(source)],
                   check=True)
    text = srt_text(lyrics)
    print('lyrics:', text, flush=True)
    for keep in keeps:
        start = time.time()
        if lines:
            work = out / 'lines'
            work.mkdir(exist_ok=True)
            rate, pcm = convert_lines(source, srt_segments(lyrics), voice_id, keep, work)
            target = out / f'{voice_id}-lines-keep{keep}.wav'
        else:
            rate, pcm = convert(source, voice_id, text, keep)
            target = out / f'{voice_id}-keep{keep}.wav'
        write_wav(target, rate, pcm)
        print(f'keep {keep}: {len(pcm) / 2 / rate:.1f}s audio in {time.time() - start:.0f}s -> {target}', flush=True)


if __name__ == '__main__':
    main()
