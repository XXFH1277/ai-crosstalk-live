"""Download the public Breeze GGUF in resumable, verified HTTP ranges."""
import concurrent.futures
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import threading
import time

import requests

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', choices=['f16', 'q8'], default='f16')
parser.add_argument('--workers', type=int, default=8)
args = parser.parse_args()
MODELS = {
    'f16': ('f16', 6279630784, 'db740cd464d75f2635a891586f083c5b466fd63542bebd957fe7890324b04c35', 'f16-model-parts'),
    'q8': ('q8_0', 3568844480, 'a02bcc4b69b0601032727f8040c4942149b1b73aa0f69022fe5aaa6a8f0ef879', 'model-parts'),
}
variant, SIZE, SHA256, parts_name = MODELS[args.model]
URL = f'https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-{variant}.gguf'
CHUNK = 64 * 1024 * 1024
PARTS = ROOT / 'downloads' / parts_name
TARGET = ROOT / 'models' / f'breeze-tts-2-{variant}.gguf'
PARTS.mkdir(parents=True, exist_ok=True)
progress = {}
lock = threading.Lock()


def get_part(i):
    start = i * CHUNK
    end = min(SIZE, start + CHUNK) - 1
    expected = end - start + 1
    path = PARTS / f'{i:04d}.part'
    for attempt in range(8):
        have = path.stat().st_size if path.exists() else 0
        if have > expected:
            raise RuntimeError(f'Oversized part {i}')
        with lock:
            progress[i] = have
        if have == expected:
            return path
        try:
            first = start + have
            with requests.get(URL, headers={'Range': f'bytes={first}-{end}'},
                              stream=True, timeout=(20, 60)) as response:
                wanted = f'bytes {first}-{end}/{SIZE}'
                if response.status_code != 206 or response.headers.get('Content-Range') != wanted:
                    raise RuntimeError(f'Invalid range response: {response.status_code}')
                with path.open('ab', buffering=0) as output:
                    for block in response.iter_content(256 * 1024):
                        if not block:
                            continue
                        if have + len(block) > expected:
                            raise RuntimeError('Server exceeded requested range')
                        output.write(block)
                        have += len(block)
                        with lock:
                            progress[i] = have
            if have == expected:
                return path
        except requests.RequestException as exc:
            print(f'Part {i}: retry {attempt + 1} ({type(exc).__name__})', flush=True)
        time.sleep(min(2 ** attempt, 20))
    raise RuntimeError(f'Could not finish part {i}')


def main():
    count = math.ceil(SIZE / CHUNK)
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(16, args.workers))) as pool:
        jobs = [pool.submit(get_part, i) for i in range(count)]
        while not all(job.done() for job in jobs):
            time.sleep(5)
            with lock:
                total = sum(progress.values())
            elapsed = time.monotonic() - started
            state = {'model': args.model, 'downloaded': total, 'total': SIZE, 'percent': round(100 * total / SIZE, 1),
                     'MiB_per_s': round(total / max(elapsed, 1) / 1048576, 2)}
            (ROOT / 'logs' / f'download-progress-{args.model}.json').write_text(json.dumps(state), encoding='utf-8')
            print(json.dumps(state), flush=True)
        paths = [job.result() for job in jobs]
    staging = TARGET.with_suffix('.gguf.assembling')
    digest = hashlib.sha256()
    with staging.open('wb') as output:
        for path in paths:
            with path.open('rb') as source:
                while block := source.read(4 * 1024 * 1024):
                    output.write(block)
                    digest.update(block)
    if staging.stat().st_size != SIZE or digest.hexdigest() != SHA256:
        raise RuntimeError('Model checksum verification failed')
    if not staging.resolve().is_relative_to(ROOT) or not TARGET.resolve().is_relative_to(ROOT):
        raise RuntimeError('Output must remain in the deployment folder')
    os.replace(staging, TARGET)
    print(f'VERIFIED {TARGET} SHA256={digest.hexdigest()}', flush=True)


if __name__ == '__main__':
    main()
