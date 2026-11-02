"""Generate a short Chinese sample and record measurable deployment results."""
import argparse
import array
import json
import math
from pathlib import Path
import time
import wave

import requests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', choices=['f16', 'q8'], required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent
text = '你好，欢迎使用本地语音合成。今天阳光很好，让我们用自然的声音，开始一段新的故事。'
payload = {
    'input': text,
    'instructions': '一位温柔自然的年轻女性，普通话标准，声音清晰，语速适中，像在与朋友轻松聊天。',
    'response_format': 'pcm',
    'cfg_scale': 4.0,
    'seed': 42,
    'max_new_tokens': 300,
}
started = time.perf_counter()
first = None
pieces = []
with requests.post('http://127.0.0.1:8080/v1/audio/speech', json=payload,
                   stream=True, timeout=(10, 180)) as response:
    response.raise_for_status()
    for block in response.iter_content(4096):
        if block:
            if first is None:
                first = time.perf_counter() - started
            pieces.append(block)
elapsed = time.perf_counter() - started
pcm = b''.join(pieces)
if len(pcm) < 24000 or len(pcm) % 2:
    raise RuntimeError(f'Unexpected audio length: {len(pcm)}')
samples = array.array('h', pcm)
rms = math.sqrt(sum(v * v for v in samples) / len(samples)) / 32768
peak = max(abs(v) for v in samples) / 32768
if rms < 0.0001:
    raise RuntimeError('Generated audio is effectively silent')
output = root / 'outputs' / f'中文试听-{args.model}.wav'
with wave.open(str(output), 'wb') as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(24000)
    audio.writeframes(pcm)
duration = len(samples) / 24000
result = {'model': args.model, 'text': text, 'sample_rate': 24000, 'channels': 1,
          'audio_seconds': round(duration, 3), 'request_seconds': round(elapsed, 3),
          'first_4096_bytes_seconds': round(first, 3),
          'real_time_factor': round(elapsed / duration, 3),
          'peak': round(peak, 4), 'rms': round(rms, 4), 'path': str(output)}
(root / 'logs' / f'verification-{args.model}.json').write_text(
    json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
