"""Give an outfit set (drawn by editing another set's base, head untouched) that set's face.

A second costume keeps the head of the first one, so it can reuse its mouth / blink / expression
patches instead of drawing them all again. Image edits still re-render the head a little, so the
first set's face is pasted back onto the new base (at the measured offset) to make them match.

Usage: python clone_face.py <源套> <新套>      e.g. python clone_face.py 深深万圣 深深万圣B
Needs 素材/透明/<源套>-脸*.png/json from merge_frames.py. Keeps the drawn base as
素材/<新套>/<新套>-基础-原图.png, writes the fixed 素材/<新套>/<新套>-基础.png and 素材/透明/<新套>-*,
then run make_poses.py <新套> for its poses.
"""
import json
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from key_green import key  # noqa: E402
from make_poses import face_offset, TALK_DIFF  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def main(src, dst):
    out = ROOT / '透明'
    src_base = Image.open(ROOT / src / f'{src}-基础.png').convert('RGB')
    drawn_path = ROOT / dst / f'{dst}-基础-原图.png'
    if not drawn_path.exists():
        shutil.copy(ROOT / dst / f'{dst}-基础.png', drawn_path)
    drawn = Image.open(drawn_path).convert('RGB')
    area = Image.open(out / f'{src}-脸-区域.png').convert('L')
    diff, dx, dy = face_offset(src_base, drawn, area)
    print(f'face offset=({dx},{dy})  diff={diff:.1f}' + ('' if diff < TALK_DIFF * 1.5 else '  ← 头变化较大，检查一下'))
    mask = area.filter(ImageFilter.MaxFilter(31)).filter(ImageFilter.GaussianBlur(8))
    fixed = Image.composite(ImageChops.offset(src_base, dx, dy), drawn, ImageChops.offset(mask, dx, dy))
    fixed.save(ROOT / dst / f'{dst}-基础.png')
    key(fixed).save(out / f'{dst}-基础.png')

    face = json.loads((out / f'{src}-脸.json').read_text(encoding='utf-8'))
    x0, y0, x1, y1 = face['box']
    face['box'] = [x0 + dx, y0 + dy, x1 + dx, y1 + dy]
    (out / f'{dst}-脸.json').write_text(json.dumps(face, ensure_ascii=False, indent=2), encoding='utf-8')
    for p in face['patches']:
        shutil.copy(out / f'{src}-脸-{p}.png', out / f'{dst}-脸-{p}.png')
    ImageChops.offset(area, dx, dy).save(out / f'{dst}-脸-区域.png')
    print(f'{dst}: base fixed, {len(face["patches"])} face patches from {src}')


if __name__ == '__main__':
    main(*sys.argv[1:3])
