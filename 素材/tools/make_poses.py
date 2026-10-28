"""Prepare action poses so the face patches from merge_frames.py can be layered on top.

For every 素材/<角色名>/动作/<角色名>-动作-*.png:
  * find how far the face moved compared with the base (searching a small offset),
  * if the face is still the base face (hands and props kept clear of it), paste the base face
    back at that offset so mouth / blink / expression patches line up exactly -> "talk" pose,
  * otherwise keep the picture as drawn -> reaction pose (shown whole, no lip sync),
then key to transparent and write 素材/透明/<角色名>-动作-*.png plus <角色名>-动作.json.

Usage: python make_poses.py <角色名> [--talk 动作名 ...]   (run merge_frames.py for that character first)
       --talk marks poses as lip-syncable even if the face measurement says otherwise.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from key_green import key  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SEARCH = 16  # px searched in each direction for the face offset
# Mean abs difference (0-255) inside the face area below which the face counts as unchanged.
# Re-rendered hair alone gives about 6-16; a hand or a turned head over the face gives 30+.
TALK_DIFF = 20.0


def gray(img):
    return np.asarray(img.convert('L'), dtype=np.float32)


def face_offset(base, pose, area):
    """Offset (dx, dy) of the pose's face relative to the base, and the remaining difference there."""
    b, p, m = gray(base), gray(pose), np.asarray(area, dtype=np.float32) / 255
    ys, xs = np.nonzero(m > 0.5)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    ref, w = b[y0:y1, x0:x1], m[y0:y1, x0:x1]
    best = (float('inf'), 0, 0)
    for dy in range(-SEARCH, SEARCH + 1, 2):
        for dx in range(-SEARCH, SEARCH + 1, 2):
            if y0 + dy < 0 or x0 + dx < 0 or y1 + dy > p.shape[0] or x1 + dx > p.shape[1]:
                continue
            d = (np.abs(p[y0 + dy:y1 + dy, x0 + dx:x1 + dx] - ref) * w).sum() / w.sum()
            best = min(best, (d, dx, dy))
    # refine around the coarse best at 1 px
    _, cx, cy = best
    for dy in range(cy - 1, cy + 2):
        for dx in range(cx - 1, cx + 2):
            if y0 + dy < 0 or x0 + dx < 0 or y1 + dy > p.shape[0] or x1 + dx > p.shape[1]:
                continue
            d = (np.abs(p[y0 + dy:y1 + dy, x0 + dx:x1 + dx] - ref) * w).sum() / w.sum()
            best = min(best, (d, dx, dy))
    return best


def main(name, force_talk=()):
    out_dir = ROOT / '透明'
    base = Image.open(ROOT / name / f'{name}-基础.png').convert('RGB')
    area = Image.open(out_dir / f'{name}-脸-区域.png').convert('L')
    # Paste a little more than the patched area so patch edges sit on base pixels.
    paste_mask = area.filter(ImageFilter.MaxFilter(31)).filter(ImageFilter.GaussianBlur(8))
    manifest = {}
    for path in sorted((ROOT / name / '动作').glob(f'{name}-动作-*.png')):
        label = path.stem.removeprefix(f'{name}-动作-')
        pose = Image.open(path).convert('RGB')
        if pose.size != base.size:
            raise SystemExit(f'{path.name} is {pose.size}, base is {base.size}')
        diff, dx, dy = face_offset(base, pose, area)
        # --talk overrides the measurement for poses checked by eye (e.g. 月月's white hair
        # re-rendered around an unchanged face scores a little over the line).
        talk = diff < TALK_DIFF or label in force_talk
        if talk:
            shifted = ImageChops.offset(base, dx, dy)
            mask = ImageChops.offset(paste_mask, dx, dy)
            pose = Image.composite(shifted, pose, mask)
        key(pose).save(out_dir / f'{name}-动作-{label}.png')
        manifest[label] = {'talk': bool(talk), 'dx': int(dx), 'dy': int(dy), 'faceDiff': round(float(diff), 1)}
        print(f"{label}: {'可叠口型' if talk else '反应动作'}  offset=({dx},{dy})  face diff={diff:.1f}")
    (out_dir / f'{name}-动作.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    args = sys.argv[1:]
    talk = args[args.index('--talk') + 1:] if '--talk' in args else []
    main(args[0], tuple(talk))
