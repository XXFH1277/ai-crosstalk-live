"""Turn a #00FF00 green-screen illustration into a transparent PNG with green spill removed.

Usage: python key_green.py <input.png> <output.png>
"""
import sys

import numpy as np
from PIL import Image

# Green dominance (G minus the larger of R and B) at which a pixel is fully
# foreground / fully background. The screens sit around 240; nothing in either
# character is greener than it is red or blue, so any positive dominance is spill.
SOLID, CLEAR = 10, 110
# Hair runs off the left/right edges of the canvas; fade it out over this many px
# so it does not end in a hard vertical line on stream.
EDGE_FADE = 64


def key(image):
    rgb = np.asarray(image.convert('RGB')).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    dominance = g - np.maximum(r, b)
    alpha = 1 - np.clip((dominance - SOLID) / (CLEAR - SOLID), 0, 1)
    x = np.arange(alpha.shape[1])
    alpha *= np.clip(np.minimum(x, alpha.shape[1] - 1 - x) / EDGE_FADE, 0, 1)
    # Despill: no colour in either character is green, so cap G at max(R, B).
    # Blue hair mixed with the screen comes out teal rather than green, so in
    # the blue family (B > R) cap harder, at the R/B average.
    limit = np.where(b > r, (r + b) / 2, np.maximum(r, b))
    rgb[..., 1] = np.minimum(g, limit)
    out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


if __name__ == '__main__':
    key(Image.open(sys.argv[1])).save(sys.argv[2])
