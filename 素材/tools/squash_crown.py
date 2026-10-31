"""Lower a crown that was drawn too high: rows [top, keep) are squashed into [top + by, keep).

Rows from `keep` down (forehead, face, body) are untouched, so face patches still line up; the
same call on every picture of a set keeps their heads identical. Green screen fills the gap above.
Used for 小克睡衣, whose hair was filled in too tall where the witch hat had been.

Usage: python squash_crown.py <top> <keep> <by> <in.png> <out.png> [<in.png> <out.png> ...]
"""
import sys

from PIL import Image

top, keep, by = (int(v) for v in sys.argv[1:4])
pairs = sys.argv[4:]
for src, dst in zip(pairs[::2], pairs[1::2]):
    im = Image.open(src).convert('RGB')
    band = im.crop((0, top, im.width, keep)).resize((im.width, keep - top - by), Image.LANCZOS)
    out = im.copy()
    out.paste((0, 255, 0), (0, 0, im.width, top + by))
    out.paste(im.crop((0, 0, im.width, top)), (0, by))
    out.paste(band, (0, top + by))
    out.save(dst)
    print(dst)
