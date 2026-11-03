"""Regenerate every app icon file from the original artwork, assets/icon/source.jpg.

    python assets/icon/make_icons.py        (needs Pillow and NumPy: pip install pillow numpy)

source.jpg is kept exactly as it was supplied (a 1375 px JPEG: the phone and the masked pin on a
white background). This script never modifies it. It:

1. removes the white background: every near-white area connected to the image border, plus the
   white areas enclosed by the artwork that are background showing through (the gap between the
   pin and its ring). White strokes that belong to the artwork (the phone's rim, the arrows, the
   compass) are separated from the background by the dark outline, so they stay;
2. turns the soft JPEG edge into real transparency: along the outline, each pixel's opacity is
   worked out from how much white it was mixed with, and the white is taken back out of its colour,
   so the icon has no white fringe on dark backgrounds (taskbar, dark title bars);
3. crops tightly around the artwork and centres it on a square transparent canvas, so it fills
   as much of the icon as possible (the phone's own rounded corners give the rounded outline);
4. writes PNGs (16-1024 px), a multi-size icon.ico and the copies the UI serves (ui/icon-*.png).

Small sizes are sharpened slightly after downscaling so they don't look soft.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SOURCE = HERE / "source.jpg"

WHITE_MIN = 205  # a pixel is background-white when every channel is at least this ...
WHITE_CHROMA = 28  # ... and its channels differ by at most this (JPEG noise is slightly tinted)
# Enclosed white areas smaller than this share of the image are part of the artwork (highlights,
# arrow strokes); the hole between the pin and its ring is about 0.2 %, the strokes are larger.
HOLE_MAX_SHARE = 0.004
HOLES = [(870, 230)]  # (y, x) inside each enclosed background area: the gap inside the pin's ring
EDGE_PX = 3  # width of the soft edge band that gets fractional opacity
OUTLINE = np.array([29.0, 36.0, 51.0])  # the artwork's dark navy outline colour
MARGIN = 1 / 64  # transparent border around the artwork, as a share of the icon size

PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
UI_SIZES = [32, 64, 256]


def _flood(mask: np.ndarray, seeds: list[tuple[int, int]]) -> np.ndarray:
    """Pixels of `mask` 4-connected to any seed."""
    h, w = mask.shape
    out = np.zeros_like(mask)
    q = deque((y, x) for y, x in seeds if mask[y, x])
    for y, x in q:
        out[y, x] = True
    while q:
        y, x = q.popleft()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                q.append((ny, nx))
    return out


def _dilate(mask: np.ndarray, r: int) -> np.ndarray:
    img = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(2 * r + 1))
    return np.asarray(img) > 127


def cutout() -> Image.Image:
    """The artwork with a transparent background, cropped to its outline."""
    rgb = np.asarray(Image.open(SOURCE).convert("RGB")).astype(np.float64)
    h, w, _ = rgb.shape
    hi, lo = rgb.max(axis=2), rgb.min(axis=2)
    white = (lo >= WHITE_MIN) & (hi - lo <= WHITE_CHROMA)
    border = [(y, x) for y in (0, h - 1) for x in range(0, w, 7)] + [(y, x) for x in (0, w - 1) for y in range(0, h, 7)]
    background = _flood(white, border)
    for y, x in HOLES:
        hole = _flood(white, [(y, x)])
        if 0 < hole.sum() <= HOLE_MAX_SHARE * h * w:
            background |= hole
    # Opacity: 0 on the background, 1 inside the artwork; across the soft edge band it follows how
    # much of the white background is mixed into the pixel (relative to the dark outline).
    band = _dilate(background, EDGE_PX) & ~background
    alpha = np.where(background, 0.0, 1.0)
    white_v, dark = 255.0, OUTLINE
    mix = np.clip((white_v - rgb) / (white_v - dark), 0.0, 1.0).mean(axis=2)
    alpha = np.where(band, np.clip(mix, 0.0, 1.0), alpha)
    # Take the white back out of the edge colours: c = (p - (1 - a) * 255) / a.
    a3 = np.maximum(alpha, 1e-3)[..., None]
    colour = np.clip((rgb - (1.0 - a3) * white_v) / a3, 0.0, 255.0)
    colour = np.where(band[..., None], colour, rgb)
    rgba = np.dstack([colour, alpha * 255.0]).round().astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    return img.crop(img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox())


def master() -> Image.Image:
    """1024 px square icon: the cut-out artwork centred with a small transparent margin."""
    art = cutout()
    size = 1024
    room = round(size * (1 - 2 * MARGIN))
    scale = room / max(art.size)
    art = premultiplied_resize(art, (max(1, round(art.width * scale)), max(1, round(art.height * scale))))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return out


def premultiplied_resize(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    # Premultiplied resampling avoids dark or light fringes along the transparent edge.
    r, g, b, a = img.split()
    pre = Image.merge("RGB", [ImageChops.multiply(c, a) for c in (r, g, b)]).resize(size, Image.LANCZOS)
    a_small = a.resize(size, Image.LANCZOS)
    ar = np.asarray(a_small).astype(np.float64)[..., None] / 255.0
    rgb = np.asarray(pre).astype(np.float64) / np.maximum(ar, 1e-3)
    return Image.fromarray(np.dstack([np.clip(rgb, 0, 255), ar[..., 0] * 255]).round().astype(np.uint8), "RGBA")


def scaled(img: Image.Image, n: int) -> Image.Image:
    small = premultiplied_resize(img, (n, n))
    if n <= 64:
        r, g, b, a = small.split()
        rgb = Image.merge("RGB", (r, g, b)).filter(ImageFilter.UnsharpMask(radius=0.6, percent=80, threshold=1))
        small = Image.merge("RGBA", (*rgb.split(), a))
    return small


def main() -> None:
    big = master()
    for n in PNG_SIZES:
        scaled(big, n).save(HERE / f"icon-{n}.png", optimize=True)
    ico_images = [scaled(big, n) for n in ICO_SIZES]
    ico_images[-1].save(HERE / "icon.ico", sizes=[(n, n) for n in ICO_SIZES], append_images=ico_images[:-1])
    for n in UI_SIZES:
        scaled(big, n).save(ROOT / "ui" / f"icon-{n}.png", optimize=True)
    print(f"wrote {len(PNG_SIZES)} PNGs, icon.ico and {len(UI_SIZES)} UI icons from {SOURCE.name}")


if __name__ == "__main__":
    main()
