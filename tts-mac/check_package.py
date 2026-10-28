"""Offline integrity check for the immutable portable application files."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent

def check(all_files=False):
    manifest = json.loads((ROOT/'package-manifest.json').read_text(encoding='utf-8-sig'))
    checked = 0
    for entry in manifest['files']:
        if entry.get('mutable') and not all_files:
            continue
        path = (ROOT/entry['path']).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            raise RuntimeError('Missing package file: '+entry['path'])
        if path.stat().st_size != entry['bytes']:
            raise RuntimeError('Incomplete file: '+entry['path'])
        h = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda:stream.read(8*1024*1024),b''):
                h.update(block)
        if h.hexdigest()!=entry['sha256']:
            raise RuntimeError('SHA256 mismatch: '+entry['path'])
        checked += 1
        if entry['path'].startswith('models/'):
            print('Verified '+entry['path'],flush=True)
    print(f'PACKAGE_OK: {checked} files',flush=True)

if __name__=='__main__':
    try:
        check('--all' in sys.argv)
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
