"""Score re-sung takes against the source vocal: lyric accuracy and melody shape.

Usage: python sing_score.py <source_vocals.wav> <lyrics.srt> <take.wav> [take.wav ...]
- CER: Whisper transcription vs the lyrics (lower is better). The source vocal is
  scored too, as a baseline for how well Whisper copes with this singing.
- Melody: correlation of pitch contours in semitones after removing each track's
  median, so a take sung in a different register still scores on shape.
"""
import os
import re
import sys

import librosa
import numpy as np
import whisper
import zhconv

from sing_convert import srt_text

SR = 16000


def clean(text):
    return re.sub(r'[^一-鿿]', '', zhconv.convert(text, 'zh-cn'))


def cer(ref, hyp):
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        current = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h))
        previous = current
    return previous[-1] / max(len(ref), 1)


def contour(path):
    audio, _ = librosa.load(path, sr=SR, mono=True)
    f0, voiced, _ = librosa.pyin(audio, fmin=80, fmax=1000, sr=SR, frame_length=1024, hop_length=320)
    return f0, voiced, audio


def melody(src, take):
    (f_a, v_a, _), (f_b, v_b, _) = src, take
    n = min(len(f_a), len(f_b))
    both = v_a[:n] & v_b[:n]
    if both.sum() < 20:
        return float('nan'), float('nan'), 0.0
    a = 12 * np.log2(f_a[:n][both])
    b = 12 * np.log2(f_b[:n][both])
    shift = np.median(b) - np.median(a)
    corr = float(np.corrcoef(a - np.median(a), b - np.median(b))[0, 1])
    return corr, float(shift), float(both.sum() / max(v_a[:n].sum(), 1))


def main():
    source, lyrics, *takes = sys.argv[1:]
    reference = clean(srt_text(lyrics))
    model = whisper.load_model(os.environ.get('WHISPER_MODEL', 'turbo'))
    src = contour(source)
    print(f'{"track":34} {"CER":>6} {"melody":>7} {"shift(st)":>9} {"voiced":>7} {"medianHz":>8}')
    for path in [source, *takes]:
        data = src if path == source else contour(path)
        text = model.transcribe(data[2].astype(np.float32), language='zh', fp16=False)['text']
        corr, shift, overlap = melody(src, data) if path != source else (1.0, 0.0, 1.0)
        median = float(np.nanmedian(data[0][data[1]])) if data[1].any() else float('nan')
        name = path.split('/')[-1]
        print(f'{name:34} {cer(reference, clean(text)):6.2f} {corr:7.2f} {shift:9.1f} {overlap:7.2f} {median:8.0f}')
        print('   ', clean(text))


if __name__ == '__main__':
    main()
