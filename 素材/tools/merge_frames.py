"""Paste only the changed face region of each variant back onto the base, then key to transparent.

Image edits re-render the whole picture, so hair and clothes drift a little between
frames. Taking just the face from each variant keeps every frame pixel-identical to
the base outside the face, so switching frames on stream does not make the body jitter.

Usage: python merge_frames.py <角色名>      e.g. python merge_frames.py 深深
Reads  素材/<角色名>/<角色名>-*.png, writes 素材/透明/<角色名>-*.png, a contact sheet, and face
patches (素材/透明/<角色名>-脸-*.png + <角色名>-脸.json) that make_poses.py and the overlay layer
on top of action poses.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from key_green import key  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DIFF_THRESHOLD = 28  # mean RGB difference that counts as an intended change
GROW, FEATHER = 13, 6  # px: dilate the change mask, then soften its edge
CHIN_MARGIN = 40  # px below the open mouth that still belong to the face


def face_box(base, variants):
    """Union of strong changes across all variants, limited to the upper half of the image."""
    hits = np.zeros(base.size[::-1], bool)
    for v in variants:
        d = np.asarray(ImageChops.difference(base, v).convert('L').filter(ImageFilter.GaussianBlur(2)))
        hits |= d > DIFF_THRESHOLD
    hits[base.height // 2:] = False
    ys, xs = np.nonzero(hits)
    # Trim stray specks: the box spans the 2nd..98th percentile of changed pixels.
    x0, x1 = np.percentile(xs, [2, 98]).astype(int)
    y0, y1 = np.percentile(ys, [2, 98]).astype(int)
    pad = 24
    return max(0, x0 - pad), max(0, y0 - pad), min(base.width, x1 + pad), min(base.height // 2, y1 + pad)


def merge(base, variant, box):
    d = ImageChops.difference(base, variant).convert('L').filter(ImageFilter.GaussianBlur(2))
    changed = d.point(lambda v: 255 if v > DIFF_THRESHOLD else 0)
    region = Image.new('L', base.size, 0)
    ImageDraw.Draw(region).rectangle(box, fill=255)
    mask = ImageChops.multiply(changed, region).filter(ImageFilter.MaxFilter(GROW)).filter(ImageFilter.GaussianBlur(FEATHER))
    drift = np.asarray(ImageChops.multiply(changed, ImageChops.invert(region))).astype(bool).mean()
    return Image.composite(variant, base, mask), drift, mask


def main(name):
    folder = ROOT / name
    base = Image.open(folder / f'{name}-基础.png').convert('RGB')
    paths = sorted(p for p in folder.glob(f'{name}-*.png') if p.stem != f'{name}-基础')
    variants = [Image.open(p).convert('RGB') for p in paths]
    for p, v in zip(paths, variants):
        if v.size != base.size:
            raise SystemExit(f'{p.name} is {v.size}, base is {base.size}')
    box = face_box(base, variants)
    print('face box:', box)
    out_dir = ROOT / '透明'
    out_dir.mkdir(exist_ok=True)
    frames = [('基础', base)]
    key(base).save(out_dir / f'{name}-基础.png')
    union = Image.new('L', base.size, 0)
    patches = []
    # Chin line: nothing below the lowest point of the open mouth (+ CHIN_MARGIN) is "face".
    # Without it, small collar changes in some expressions made the patches carry the maid
    # collar onto other outfits (the 大褂's stand-up collar).
    mouth = next((v for p, v in zip(paths, variants) if p.stem.endswith('嘴-张大')), None)
    chin = None
    if mouth is not None:
        # The mouth is where the open-mouth frame differs most densely; stray collar pixels
        # that also changed are too sparse to count.
        d = np.asarray(ImageChops.difference(base, mouth).convert('L')) > 60
        x0, y0, x1, y1 = box
        # Only the middle band of the face box: re-rendered hair at the sides changes densely too.
        cx, band = (x0 + x1) // 2, (x1 - x0) // 6
        rows = d[y0:y1, cx - band:cx + band].sum(axis=1)
        # Walk down from the densest row (inside the mouth) until a run of quiet rows: that is
        # the bottom of the mouth. Further changes (a re-drawn bow on the collar) are ignored.
        y, quiet = int(rows.argmax()), 0
        while y + 1 < len(rows) and quiet < 8:
            y += 1
            quiet = quiet + 1 if rows[y] < 0.1 * rows.max() else 0
        chin = y0 + y - quiet + CHIN_MARGIN if rows.max() else None
    print('chin line:', chin)
    for p, v in zip(paths, variants):
        merged, drift, mask = merge(base, v, box)
        if chin:
            fade = Image.linear_gradient('L').resize((base.width, 24)).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            below = Image.new('L', base.size, 255)
            below.paste(0, (0, chin, base.width, base.height))
            below.paste(fade, (0, chin - 24))
            mask = ImageChops.multiply(mask, below)
            merged = Image.composite(v, base, mask)
        keyed = key(merged)
        keyed.save(out_dir / p.name)
        label = p.stem.removeprefix(f'{name}-')
        frames.append((label, merged))
        print(f'{len(frames) - 1} {p.name}: changes outside face box {drift:.1%}')
        # Face patch: only the changed pixels, cropped to the face box, for layering over action poses.
        patch = keyed.copy()
        patch.putalpha(ImageChops.multiply(keyed.getchannel('A'), mask))
        patch.crop(box).save(out_dir / f'{name}-脸-{label}.png')
        patches.append(label)
        union = ImageChops.lighter(union, mask)
    union.save(out_dir / f'{name}-脸-区域.png')
    manifest = {'box': [int(v) for v in box], 'canvas': list(base.size), 'patches': patches}
    (out_dir / f'{name}-脸.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    sheet(frames, box, out_dir / f'{name}-差分一览.png')


def sheet(frames, box, path):
    """Face crops side by side, numbered in the order printed above, to eyeball every frame at once."""
    crops = [f.crop(box) for _, f in frames]
    w, h = crops[0].size
    scale = 260 / h
    tile = (int(w * scale), 260)
    out = Image.new('RGB', (tile[0] * len(crops), tile[1] + 28), (30, 30, 40))
    draw = ImageDraw.Draw(out)
    for i, c in enumerate(crops):
        out.paste(c.resize(tile), (i * tile[0], 28))
        draw.text((i * tile[0] + 6, 8), str(i), fill=(255, 255, 255))
    out.save(path)


if __name__ == '__main__':
    main(sys.argv[1])
