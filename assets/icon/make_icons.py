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

The taskbar and browser-tab sizes (16-64 px: the window icon, the small entries of icon.ico, the
favicons ui/icon-32/64.png and the Store package's taskbar logo) use a simplified redrawing of the
artwork instead (see small_icon), because the full artwork is unreadable that small. The in-app
logo (ui/icon-256.png) and the large icons keep the artwork.
"""

from __future__ import annotations

import math
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

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


# ---------------------------------------------------------------------------------------------
# The taskbar / browser-tab icon (16-64 px). At those sizes the full artwork turns into a dark
# smudge on a dark taskbar, so they use a redrawn, simplified version of it instead: the same
# masked red pin, much larger, over a phone with a bold white rim, with a white halo that keeps
# the pin apart from the phone and readable on dark and light taskbars alike. Drawn as vectors
# (no detail from source.jpg is resampled), so every size is crisp.
NAVY = (29, 36, 51, 255)
SCREEN_TOP, SCREEN_BOTTOM = (38, 52, 78), (20, 27, 42)
RED_LIGHT, RED_DARK, MASK_RED = (214, 50, 56, 255), (176, 34, 42, 255), (226, 62, 66, 255)
GREEN = (76, 203, 107, 255)
WHITE = (255, 255, 255, 255)
SMALL_SIZES = {16, 24, 32, 48, 64}  # these get the simplified icon; 128 px and up keep the artwork


def _teardrop(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, tip: float, fill) -> None:
    """A map pin: a circle of radius r at (cx, cy) narrowing to a point at (cx, tip)."""
    d = tip - cy
    phi = math.acos(min(1.0, r / d))  # tangent points, measured from straight down
    pts = [(cx, tip)]
    steps = 96
    start = math.pi / 2 - phi  # right tangent point (angles: 0 = right, y down)
    end = math.pi / 2 + phi - 2 * math.pi
    for i in range(steps + 1):
        a = start + (end - start) * i / steps
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    draw.polygon(pts, fill=fill)


def _grow_teardrop(cx, cy, r, tip, k):
    """The same pin grown outwards by k (an outline): the sides move out by k, so the tip moves
    down by k / sin(half-angle) = k * d / r."""
    return cx, cy, r + k, tip + k * (tip - cy) / r


def small_icon(n: int) -> Image.Image:
    ss = 8  # supersampling
    S = n * ss
    u = S / 100.0  # drawing units: the icon is 100 x 100
    tiny = n <= 24
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # phone: navy keyline, white rim, dark screen with a vertical gradient
    x0, y0, x1, y1, rad = 40, 3, 96, 97, 14
    key = 2.2 if tiny else 1.8
    rim = 7.5 if tiny else 6.0
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([(x0 - key) * u, (y0 - key) * u, (x1 + key) * u, (y1 + key) * u], radius=(rad + key) * u, fill=NAVY)
    d.rounded_rectangle([x0 * u, y0 * u, x1 * u, y1 * u], radius=rad * u, fill=WHITE)
    screen = [(x0 + rim) * u, (y0 + rim) * u, (x1 - rim) * u, (y1 - rim) * u]
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = min(1.0, max(0.0, (y / u - y0) / (y1 - y0)))
        gd.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(SCREEN_TOP, SCREEN_BOTTOM)) + (255,))
    smask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(smask).rounded_rectangle(screen, radius=max(1.0, rad - rim) * u, fill=255)
    img.paste(grad, (0, 0), smask)

    # the route: green dots climbing to the top right of the screen (left out where they'd blur)
    if not tiny:
        for (x, y) in [(62, 86), (72, 77), (79, 64), (82, 50), (83, 36), (83, 22)]:
            rr = 3.6
            d.ellipse([(x - rr) * u, (y - rr) * u, (x + rr) * u, (y + rr) * u], fill=GREEN)

    # the masked pin, with a white halo and a navy keyline
    cx, cy, r, tip = 33.0, 41.0, 25.0, 85.0
    halo, line = (3.8, 3.2) if tiny else (3.2, 2.6)
    for grow, colour in ((line + halo, WHITE), (line, NAVY)):
        _teardrop(d, *(v * u for v in _grow_teardrop(cx, cy, r, tip, grow)), fill=colour)
    pin = Image.new("L", (S, S), 0)
    _teardrop(ImageDraw.Draw(pin), cx * u, cy * u, r * u, tip * u, fill=255)
    left = Image.new("L", (S, S), 0)
    ImageDraw.Draw(left).rectangle([0, 0, cx * u, S], fill=255)
    img.paste(Image.new("RGBA", (S, S), RED_DARK), (0, 0), pin)
    img.paste(Image.new("RGBA", (S, S), RED_LIGHT), (0, 0), ImageChops.multiply(pin, left))

    # the mask across the pin's head: navy outline, red mask, navy eye holes
    my = cy - 1.0
    wing_dx, wing_rx, wing_ry = 0.44 * r, 0.50 * r, 0.33 * r
    edge = 0.13 * r if not tiny else 0.16 * r
    for grow, colour in ((edge, NAVY), (0.0, MASK_RED)):
        for sx in (-1, 1):
            ex = cx + sx * wing_dx
            d.ellipse([(ex - wing_rx - grow) * u, (my - wing_ry - grow) * u, (ex + wing_rx + grow) * u, (my + wing_ry + grow) * u], fill=colour)
        d.rectangle([(cx - wing_dx) * u, (my - wing_ry * 0.8 - grow) * u, (cx + wing_dx) * u, (my + wing_ry * 0.55 + grow) * u], fill=colour)
    eye_rx, eye_ry = (0.26 * r, 0.16 * r) if not tiny else (0.27 * r, 0.18 * r)
    for sx in (-1, 1):
        ex = cx + sx * 0.42 * r
        d.ellipse([(ex - eye_rx) * u, (my - eye_ry) * u, (ex + eye_rx) * u, (my + eye_ry) * u], fill=NAVY)

    small = premultiplied_resize(img, (n, n))
    return small


MSIX_ASSETS = {"Square44x44Logo.png": 44, "StoreLogo.png": 50, "Square150x150Logo.png": 150}


def main() -> None:
    big = master()
    icon = lambda n: small_icon(n) if n in SMALL_SIZES or n < 128 else scaled(big, n)  # noqa: E731
    for n in PNG_SIZES:
        icon(n).save(HERE / f"icon-{n}.png", optimize=True)
    ico_images = [icon(n) for n in ICO_SIZES]
    ico_images[-1].save(HERE / "icon.ico", sizes=[(n, n) for n in ICO_SIZES], append_images=ico_images[:-1])
    for n in UI_SIZES:
        icon(n).save(ROOT / "ui" / f"icon-{n}.png", optimize=True)
    msix = ROOT / "standalone" / "packaging" / "msix" / "Assets"
    msix.mkdir(parents=True, exist_ok=True)
    for name, n in MSIX_ASSETS.items():
        icon(n).save(msix / name, optimize=True)
    print(f"wrote {len(PNG_SIZES)} PNGs, icon.ico, {len(UI_SIZES)} UI icons and {len(MSIX_ASSETS)} Store logos from {SOURCE.name}")


if __name__ == "__main__":
    main()
