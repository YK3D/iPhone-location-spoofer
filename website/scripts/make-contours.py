"""Draw the topographic contour lines used behind the website's hero (src/assets/contours.svg).

The colour is baked in (the site is dark only), so the browser can show it as a plain image layer.

Smooth random terrain (a few octaves of interpolated value noise, fixed seed) traced with marching
squares, segments joined into polylines. Needs only numpy:  python website/scripts/make-contours.py
"""
from pathlib import Path

import numpy as np

W, H = 1600, 1000  # SVG units
NX, NY = 200, 125  # sample grid
LEVELS = 22
SEED = 7

rng = np.random.default_rng(SEED)


def value_noise(nx, ny, cells):
    g = rng.random((cells + 2, cells + 2))
    xs = np.linspace(0, cells, nx)
    ys = np.linspace(0, cells * ny / nx, ny)
    x0 = np.floor(xs).astype(int)
    y0 = np.floor(ys).astype(int)
    fx = xs - x0
    fy = ys - y0
    sx = fx * fx * (3 - 2 * fx)
    sy = fy * fy * (3 - 2 * fy)
    a = g[np.ix_(y0, x0)]
    b = g[np.ix_(y0, x0 + 1)]
    c = g[np.ix_(y0 + 1, x0)]
    d = g[np.ix_(y0 + 1, x0 + 1)]
    top = a + (b - a) * sx[None, :]
    bot = c + (d - c) * sx[None, :]
    return top + (bot - top) * sy[:, None]


z = sum(value_noise(NX, NY, c) / (i + 1) ** 1.3 for i, c in enumerate((3, 6, 12, 24)))
z = (z - z.min()) / (z.max() - z.min())

# marching squares: for each level, collect segments between edge midpoints (linear interpolation)
def segments(level):
    segs = []
    for j in range(NY - 1):
        for i in range(NX - 1):
            v = (z[j, i], z[j, i + 1], z[j + 1, i + 1], z[j + 1, i])
            corners = ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))
            pts = []
            for k in range(4):
                a, b = v[k], v[(k + 1) % 4]
                if (a < level) != (b < level):
                    t = (level - a) / (b - a)
                    (x1, y1), (x2, y2) = corners[k], corners[(k + 1) % 4]
                    pts.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
            if len(pts) == 2:
                segs.append((pts[0], pts[1]))
            elif len(pts) == 4:  # saddle: pair them up
                segs.append((pts[0], pts[1]))
                segs.append((pts[2], pts[3]))
    return segs


def join(segs):
    key = lambda p: (round(p[0], 4), round(p[1], 4))  # noqa: E731
    ends = {}
    for idx, (a, b) in enumerate(segs):
        ends.setdefault(key(a), []).append((idx, 0))
        ends.setdefault(key(b), []).append((idx, 1))
    used = [False] * len(segs)
    lines = []
    for start in range(len(segs)):
        if used[start]:
            continue
        used[start] = True
        line = [segs[start][0], segs[start][1]]
        for direction in (1, 0):  # grow at the tail, then at the head
            while True:
                tip = line[-1] if direction else line[0]
                nxt = None
                for idx, end in ends.get(key(tip), []):
                    if not used[idx]:
                        nxt = (idx, end)
                        break
                if nxt is None:
                    break
                idx, end = nxt
                used[idx] = True
                other = segs[idx][1 - end]
                if direction:
                    line.append(other)
                else:
                    line.insert(0, other)
        lines.append(line)
    return lines


sx, sy = W / (NX - 1), H / (NY - 1)
paths = []
for n in range(1, LEVELS):
    level = n / LEVELS
    for line in join(segments(level)):
        if len(line) < 6:
            continue
        pts = line[::2] + ([line[-1]] if len(line) % 2 == 0 else [])
        d = "M" + " ".join(f"{x * sx:.1f} {y * sy:.1f}" for x, y in pts)
        major = n % 5 == 0
        paths.append(f'<path d="{d}"{" class=\"m\"" if major else ""}/>')

svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice">'
    '<style>path{fill:none;stroke:#2f5f4d;stroke-width:1;vector-effect:non-scaling-stroke;opacity:.55}'
    "path.m{stroke-width:1.4;opacity:.9}</style>" + "".join(paths) + "</svg>"
)
out = Path(__file__).resolve().parent.parent / "src" / "assets" / "contours.svg"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(svg)
print(f"{out}: {len(paths)} lines, {len(svg) / 1024:.0f} KB")
