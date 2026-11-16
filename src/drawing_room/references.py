"""Built-in references, drawn in code so the app ships no third-party images.

Every reference lives on the same paper as the drawing (``PAPER_W`` x ``PAPER_H`` paper pixels). A reference is a
list of steps; each step is a few polylines plus a sentence telling a beginner what to draw next.
"""

from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass, field

from PIL import Image, ImageDraw

PAPER_W = 1000
PAPER_H = 750
LINE_WIDTH = 6
GUIDE_DOT = 7

Point = tuple[float, float]


@dataclass
class Step:
    text: str
    lines: list[list[Point]]

    def box(self, pad: float = 24) -> list[float]:
        xs = [x for line in self.lines for x, _ in line]
        ys = [y for line in self.lines for _, y in line]
        return [max(0, min(xs) - pad), max(0, min(ys) - pad), min(PAPER_W, max(xs) + pad), min(PAPER_H, max(ys) + pad)]


@dataclass
class Reference:
    id: str
    name: str
    steps: list[Step]
    drill: bool = False
    #: Points shown on the paper in Warm-up instead of the whole reference.
    guide_points: list[Point] = field(default_factory=list)

    def meta(self) -> dict:
        return {"id": self.id, "name": self.name, "drill": self.drill,
                "steps": [{"text": step.text, "box": [round(v) for v in step.box()]} for step in self.steps]}


def _ellipse(cx: float, cy: float, rx: float, ry: float, start: float = 0.0, end: float = 360.0, n: int = 160) -> list[Point]:
    count = max(8, int(n * abs(end - start) / 360))
    return [(cx + rx * math.cos(math.radians(start + (end - start) * i / count)),
             cy + ry * math.sin(math.radians(start + (end - start) * i / count))) for i in range(count + 1)]


def _apple_body(cx: float, cy: float, size: float) -> list[Point]:
    """A closed apple outline: a circle pinched at the top and slightly at the bottom."""
    points = []
    for i in range(241):
        t = 2 * math.pi * i / 240
        radius = size * (1 - 0.05 * math.exp(-((t - math.pi / 2) % (2 * math.pi) - math.pi) ** 2 * 6)
                         - 0.2 * math.exp(-(((t + math.pi / 2) % (2 * math.pi)) - math.pi) ** 2 * 5))
        x = cx + radius * math.cos(t) * 1.06
        y = cy - radius * math.sin(t)
        points.append((x, y))
    return points


def _build() -> dict[str, Reference]:
    cx, cy = PAPER_W / 2, PAPER_H / 2
    refs = [
        Reference("line", "Straight line", [Step("Draw one confident straight line from the left dot to the right dot.",
                                                 [[(250, 470), (750, 290)]])],
                  drill=True, guide_points=[(250, 470), (750, 290)]),
        Reference("circle", "Circle", [Step("Draw a round circle through the four dots in one smooth motion.",
                                            [_ellipse(cx, cy, 220, 220)])],
                  drill=True, guide_points=[(cx + 220, cy), (cx, cy + 220), (cx - 220, cy), (cx, cy - 220), (cx, cy)]),
        Reference("ellipse", "Ellipse", [Step("Draw an ellipse that touches the four dots; keep both ends equally round.",
                                              [_ellipse(cx, cy, 300, 150)])],
                  drill=True, guide_points=[(cx + 300, cy), (cx, cy + 150), (cx - 300, cy), (cx, cy - 150)]),
    ]
    # A cube in oblique view: front square, back square offset up and right, then the receding edges.
    s, ox, oy = 280, 120, -100
    fx, fy = cx - s / 2 - ox / 2, cy - s / 2 - oy / 2
    front = [(fx, fy), (fx + s, fy), (fx + s, fy + s), (fx, fy + s), (fx, fy)]
    back = [(x + ox, y + oy) for x, y in front]
    edges = [[front[i], back[i]] for i in range(4)]
    refs.append(Reference("cube", "Cube", [
        Step("Start with the front face: a square, four straight sides.", [front]),
        Step("Draw the back face: the same square, shifted up and to the right.", [back]),
        Step("Connect each front corner to the matching back corner with parallel lines.", edges),
    ]))
    # A cylinder standing up: top ellipse, two sides, the front half of the bottom ellipse.
    rx, ry, top, bottom = 170, 60, cy - 190, cy + 190
    refs.append(Reference("cylinder", "Cylinder", [
        Step("Draw the top ellipse first; it sets the width of the whole cylinder.", [_ellipse(cx, top, rx, ry)]),
        Step("Drop two straight vertical sides from the ends of the ellipse.", [[(cx - rx, top), (cx - rx, bottom)],
                                                                                [(cx + rx, top), (cx + rx, bottom)]]),
        Step("Close the bottom with the front half of an ellipse, the same width as the top.",
             [_ellipse(cx, bottom, rx, ry, 0, 180)]),
    ]))
    body_cy, size = cy + 30, 230
    stem = [(cx - 4, body_cy - size * 0.80), (cx + 2, body_cy - size * 0.98), (cx + 14, body_cy - size * 1.18)]
    leaf_base = (cx + 14, body_cy - size * 1.02)
    leaf = ([(leaf_base[0] + 110 * t, leaf_base[1] - 40 * t - 38 * math.sin(math.pi * t)) for t in [i / 20 for i in range(21)]]
            + [(leaf_base[0] + 110 * t, leaf_base[1] - 40 * t + 26 * math.sin(math.pi * t)) for t in [i / 20 for i in range(20, -1, -1)]])
    refs.append(Reference("apple", "Apple outline", [
        Step("Draw the round body of the apple, with a small dip at the top.", [_apple_body(cx, body_cy, size)]),
        Step("Add the short stem rising from the dip.", [stem]),
        Step("Finish with a leaf next to the stem.", [leaf]),
    ]))
    return {ref.id: ref for ref in refs}


BUILTINS = _build()


def render(ref: Reference, steps: list[int] | None = None, guide: bool = False, scale: float = 1.0) -> Image.Image:
    """The reference as black line art on white (or its guide dots only), at ``scale`` times paper size."""
    image = Image.new("RGB", (round(PAPER_W * scale), round(PAPER_H * scale)), "white")
    draw = ImageDraw.Draw(image)
    if guide:
        r = GUIDE_DOT * scale
        for x, y in ref.guide_points:
            draw.ellipse([x * scale - r, y * scale - r, x * scale + r, y * scale + r], fill=(40, 40, 40))
        return image
    for index, step in enumerate(ref.steps):
        if steps is not None and index not in steps:
            continue
        for line in step.lines:
            draw.line([(x * scale, y * scale) for x, y in line], fill="black", width=max(1, round(LINE_WIDTH * scale)),
                      joint="curve")
    return image


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


MAX_IMAGE_PIXELS = 4096 * 4096


def decode_data_url(data_url: str) -> Image.Image:
    """An uploaded reference sent as a ``data:image/...;base64,`` URL, letterboxed onto white paper."""
    if not isinstance(data_url, str) or not data_url.startswith("data:image/") or "," not in data_url:
        raise ValueError("the reference image must be a data:image URL")
    raw = base64.b64decode(data_url.split(",", 1)[1], validate=False)
    image = Image.open(io.BytesIO(raw))
    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise ValueError("the reference image is too large")
    image.load()
    return letterbox(image)


def letterbox(image: Image.Image) -> Image.Image:
    """Fit ``image`` into the paper, centred on white; transparency becomes white."""
    rgba = image.convert("RGBA")
    flat = Image.new("RGB", rgba.size, "white")
    flat.paste(rgba, mask=rgba.split()[3])
    if flat.size == (PAPER_W, PAPER_H):
        return flat
    scale = min(PAPER_W / flat.width, PAPER_H / flat.height)
    size = (max(1, round(flat.width * scale)), max(1, round(flat.height * scale)))
    paper = Image.new("RGB", (PAPER_W, PAPER_H), "white")
    paper.paste(flat.resize(size, Image.LANCZOS), ((PAPER_W - size[0]) // 2, (PAPER_H - size[1]) // 2))
    return paper
