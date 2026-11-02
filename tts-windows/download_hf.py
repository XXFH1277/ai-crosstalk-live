"""Download and verify the selected model using Hugging Face's Xet client."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

root = Path(__file__).resolve().parent
os.environ['HF_HOME'] = str(root / 'downloads' / 'hf-cache')
os.environ['HF_XET_HIGH_PERFORMANCE'] = '1'
os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '60'
os.environ['HF_HUB_ETAG_TIMEOUT'] = '30'
from huggingface_hub import hf_hub_download
from tqdm.auto import tqdm

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', choices=['f16', 'q8'], required=True)
args = parser.parse_args()
models = {
    'f16': ('f16', 6279630784, 'db740cd464d75f2635a891586f083c5b466fd63542bebd957fe7890324b04c35'),
    'q8': ('q8_0', 3568844480, 'a02bcc4b69b0601032727f8040c4942149b1b73aa0f69022fe5aaa6a8f0ef879'),
}
variant, expected_size, expected_sha = models[args.model]


class Progress(tqdm):
    last_report = 0

    def update(self, n=1):
        result = super().update(n)
        now = time.time()
        if now - self.last_report > 5 or self.n == self.total:
            state = {'model': args.model, 'downloaded': self.n, 'total': self.total,
                     'percent': round(self.n / self.total * 100, 1) if self.total else 0,
                     'bytes_per_second': self.format_dict.get('rate')}
            (root / 'logs' / f'hf-progress-{args.model}.json').write_text(json.dumps(state), encoding='utf-8')
            self.last_report = now
        return result


path = Path(hf_hub_download('HoppouAI/Breeze-TTS-2.cpp', f'breeze-tts-2-{variant}.gguf',
                          local_dir=root / 'models', token=False, tqdm_class=Progress))
digest = hashlib.sha256()
with path.open('rb') as source:
    while block := source.read(8 * 1024 * 1024):
        digest.update(block)
if path.stat().st_size != expected_size or digest.hexdigest() != expected_sha:
    raise RuntimeError('Model file checksum verification failed')
record = {'model': args.model, 'path': str(path), 'bytes': path.stat().st_size,
          'sha256': digest.hexdigest(), 'verified': True}
(root / 'logs' / f'model-verified-{args.model}.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
print(json.dumps(record), flush=True)
