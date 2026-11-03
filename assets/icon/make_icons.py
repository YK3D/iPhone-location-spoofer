"""Regenerate every app icon file from assets/icon/source.webp.

    python assets/icon/make_icons.py        (needs Pillow: pip install pillow)

The source artwork is a 1024 px render of a navy rounded tile on a grey canvas. The tile is
786 x 818 px (not square) and the USB cable pokes out of its bottom edge, so this script:

1. cuts the tile out of the grey canvas (the cable is clipped to the tile),
2. widens it to a square by extending the navy background 16 px on each side,
3. writes PNGs (16-1024 px), a multi-size icon.ico and the copies the UI serves.

Small sizes are sharpened slightly after downscaling so they don't look soft.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SOURCE = HERE / "source.webp"

# Tile geometry in the source image (measured from its navy pixels).
TILE_LEFT, TILE_TOP, TILE_W, TILE_H = 119, 103, 786, 818
TILE_RADIUS = 152
NAVY = (24, 35, 52)
MARGIN = 1 / 32  # transparent border around the tile, as a share of the icon size
SS = 4  # supersampling factor for anti-aliased masks

PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
UI_SIZES = [32, 64, 256]


def rounded_mask(w: int, h: int, radius: float, inset: float = 0.0) -> Image.Image:
    """Anti-aliased mask of a (w x h) rounded rectangle shrunk by `inset` px on every side."""
    big = Image.new("L", (w * SS, h * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        [inset * SS, inset * SS, (w - inset) * SS - 1, (h - inset) * SS - 1],
        radius=max(0.0, radius - inset) * SS,
        fill=255,
    )
    return big.resize((w, h), Image.LANCZOS)


def master() -> Image.Image:
    src = Image.open(SOURCE).convert("RGB")
    tile = src.crop((TILE_LEFT, TILE_TOP, TILE_LEFT + TILE_W, TILE_TOP + TILE_H))
    side = TILE_H
    pad = (side - TILE_W) // 2
    # Navy square, then the artwork pasted over it. The artwork keeps only pixels well inside
    # its own tile edge, so the grey canvas never bleeds into the widened background.
    canvas = Image.new("RGB", (side, side), NAVY)
    art_mask = rounded_mask(TILE_W, TILE_H, TILE_RADIUS, inset=4).filter(ImageFilter.GaussianBlur(1.2))
    canvas.paste(tile, (pad, 0), art_mask)
    square_shape = Image.new("L", (side * SS, side * SS), 0)
    ImageDraw.Draw(square_shape).rounded_rectangle([0, 0, side * SS - 1, side * SS - 1], radius=TILE_RADIUS * SS, fill=255)
    alpha = square_shape.resize((side, side), Image.LANCZOS)
    out = canvas.convert("RGBA")
    out.putalpha(alpha)
    # Place the tile on a 1024 canvas with a small transparent margin.
    size = 1024
    inner = round(size * (1 - 2 * MARGIN))
    tile_scaled = out.resize((inner, inner), Image.LANCZOS)
    final = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    off = (size - inner) // 2
    final.alpha_composite(tile_scaled, (off, off))
    return final


def scaled(img: Image.Image, n: int) -> Image.Image:
    # Premultiplied downscale avoids dark fringes on the transparent corners.
    r, g, b, a = img.split()
    pre = Image.merge("RGB", [ImageChops.multiply(c, a) for c in (r, g, b)])
    pre_small = pre.resize((n, n), Image.LANCZOS)
    a_small = a.resize((n, n), Image.LANCZOS)
    if n <= 64:
        pre_small = pre_small.filter(ImageFilter.UnsharpMask(radius=0.6, percent=80, threshold=1))
    # un-premultiply
    px_rgb = pre_small.load()
    px_a = a_small.load()
    out = Image.new("RGBA", (n, n))
    po = out.load()
    for y in range(n):
        for x in range(n):
            al = px_a[x, y]
            if al == 0:
                po[x, y] = (0, 0, 0, 0)
                continue
            rr, gg, bb = px_rgb[x, y]
            po[x, y] = (min(255, rr * 255 // al), min(255, gg * 255 // al), min(255, bb * 255 // al), al)
    return out


def main() -> None:
    big = master()
    images = {n: (big if n == 1024 else scaled(big, n)) for n in sorted(set(PNG_SIZES + ICO_SIZES + UI_SIZES))}
    for n in PNG_SIZES:
        images[n].save(HERE / f"icon-{n}.png", optimize=True)
    ico_imgs = [images[n] for n in ICO_SIZES]
    ico_imgs[-1].save(HERE / "icon.ico", sizes=[(n, n) for n in ICO_SIZES], append_images=ico_imgs[:-1])
    for n in UI_SIZES:
        images[n].save(ROOT / "ui" / f"icon-{n}.png", optimize=True)
    print("wrote", ", ".join(f"icon-{n}.png" for n in PNG_SIZES), "icon.ico and ui/icon-{32,64,256}.png")


if __name__ == "__main__":
    main()
