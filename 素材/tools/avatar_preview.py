"""Preview avatars the way Douyin shows them: round, at 300 / 100 / 48 px, on light and dark.

Usage: python avatar_preview.py  → 素材/头像/头像预览.png, plus a round 512 px PNG per avatar.
"""
from pathlib import Path

from PIL import Image, ImageDraw

DIR = Path(__file__).resolve().parents[1] / '头像'
SIZES = [300, 100, 48]


def round_crop(img, size):
    img = img.convert('RGBA').resize((size, size), Image.LANCZOS)
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    img.putalpha(mask.resize((size, size), Image.LANCZOS))
    return img


def main():
    avatars = sorted(p for p in DIR.glob('头像-*.png') if '圆形' not in p.stem)
    row_h, pad = 340, 20
    sheet = Image.new('RGB', (2 * (sum(SIZES) + pad * 4), row_h * len(avatars)), (255, 255, 255))
    for r, path in enumerate(avatars):
        img = Image.open(path)
        round_crop(img, 512).save(DIR / f'{path.stem}-圆形.png')
        for half, bg in enumerate([(245, 245, 245), (22, 24, 35)]):
            x0 = half * (sum(SIZES) + pad * 4)
            Image.Image.paste(sheet, Image.new('RGB', (sum(SIZES) + pad * 4, row_h), bg), (x0, r * row_h))
            x = x0 + pad
            for s in SIZES:
                tile = round_crop(img, s)
                sheet.paste(tile, (x, r * row_h + (row_h - s) // 2), tile)
                x += s + pad
        print(path.name, img.size)
    sheet.save(DIR / '头像预览.png')


if __name__ == '__main__':
    main()
