"""Turn the full-window screenshots from capture.js into WebP (a fraction of the PNG size).

    python docs/screenshots/to_webp.py      (needs Pillow: pip install pillow)

Small cropped shots stay PNG: they are already small and stay pixel-sharp.
"""

from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
FULL_WINDOW = ["teleport", "route-alternatives", "playback-hud", "settings"]

for name in FULL_WINDOW:
    src = HERE / f"{name}.png"
    if not src.exists():
        print(f"skipped {src.name} (not captured)")
        continue
    Image.open(src).convert("RGB").save(HERE / f"{name}.webp", "WEBP", quality=82, method=6)
    src.unlink()
    print(f"{name}.webp")
