"""Deterministic scoring: how closely the person's ink follows the reference lines.

Everything happens on the paper frame (``PAPER_W`` x ``PAPER_H``), downsampled by ``SCALE`` for speed. The reference is
turned into a thin ink mask; the person's Sketch and Line strokes are rasterised at a constant thin width (pressure
does not matter for the score). A distance transform with ``TOLERANCE`` pixels of slack gives

* recall: the share of the reference's centre line that has the person's ink nearby,
* precision: the share of the person's ink that lies near the reference,

and Shape is the F-score on a 0-10 scale. Proportion compares the spread of the two inks along x and y separately, so
a squashed circle loses Proportion even when it is traced in the right place. In levels 3 and 4 the drawing is first
moved and scaled (uniformly, never rotated) onto the reference, so drawing bigger, smaller or elsewhere on the paper is
fine but wrong proportions are not.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from drawing_room.references import PAPER_H, PAPER_W, Reference, render

SCALE = 0.5
TOLERANCE = 4.0  # score pixels (8 paper pixels): full credit this close to the line
FALLOFF = 8.0  # credit then fades linearly to zero over this many more score pixels
MISS_DISTANCE = 6.0  # ink further than this from the other ink is marked as a miss or a stray
USER_WIDTH = 2
SCORED_LAYERS = {"sketch", "line"}  # used when a stroke does not say whether its layer is scored
SHORT_STROKE = 25.0  # paper pixels; shorter strokes count as scratchy
F_FOR_TEN = 0.92
PROPORTION_SLACK = 0.03
PROPORTION_ZERO = 0.7
MIN_REGION = 10  # score pixels of missed ink before a region is reported
MAX_REGIONS = 6
ALIGNED_LEVELS = {3, 4}

W, H = round(PAPER_W * SCALE), round(PAPER_H * SCALE)


@dataclass
class Transform:
    """``paper = (user - source) * scale + target``; the identity unless the level aligns the drawing."""

    scale: float = 1.0
    source: tuple[float, float] = (0.0, 0.0)
    target: tuple[float, float] = (0.0, 0.0)

    def forward(self, x: float, y: float) -> tuple[float, float]:
        return (x - self.source[0]) * self.scale + self.target[0], (y - self.source[1]) * self.scale + self.target[1]

    def inverse(self, x: float, y: float) -> tuple[float, float]:
        return (x - self.target[0]) / self.scale + self.source[0], (y - self.target[1]) / self.scale + self.source[1]

    def then(self, after: "Transform") -> "Transform":
        """This transform followed by ``after``, as one transform."""
        return Transform(self.scale * after.scale, self.source,
                         ((self.target[0] - after.source[0]) * after.scale + after.target[0],
                          (self.target[1] - after.source[1]) * after.scale + after.target[1]))

    def as_dict(self) -> dict:
        return {"scale": round(self.scale, 4), "source": [round(v, 1) for v in self.source],
                "target": [round(v, 1) for v in self.target]}


# ---------------------------------------------------------------- reference extraction

def is_line_art(gray: np.ndarray) -> bool:
    """Mostly white paper with a little dark ink and few mid tones."""
    dark = np.mean(gray < 110)
    mid = np.mean((gray >= 110) & (gray < 200))
    light = np.mean(gray >= 200)
    return light > 0.6 and dark < 0.3 and mid < 0.12


def extract_lines(image: Image.Image) -> tuple[np.ndarray, str]:
    """The reference's ink as a boolean mask at score size, and how it was found ("line-art" or "edges")."""
    small = image.convert("L").resize((W, H), Image.LANCZOS)
    gray = np.asarray(small, dtype=np.float32)
    if is_line_art(gray):
        return gray < 160, "line-art"
    smooth = ndimage.gaussian_filter(gray, 1.5)
    magnitude = np.hypot(ndimage.sobel(smooth, axis=1), ndimage.sobel(smooth, axis=0))
    if magnitude.max() <= 0:
        return np.zeros_like(gray, dtype=bool), "edges"
    threshold = max(np.percentile(magnitude, 90), 0.2 * magnitude.max())
    edges = magnitude > threshold
    edges = ndimage.binary_opening(edges, iterations=1) | (magnitude > 0.5 * magnitude.max())
    return edges, "edges"


def centre_line(mask: np.ndarray) -> np.ndarray:
    """A thin ridge through thick ink, so a single pencil line can cover a thick reference stroke."""
    if not mask.any():
        return mask
    depth = ndimage.distance_transform_edt(mask)
    ridge = mask & (depth >= ndimage.maximum_filter(depth, size=3) - 0.5)
    return ridge


def reference_mask(reference: Reference | Image.Image) -> tuple[np.ndarray, str]:
    if isinstance(reference, Reference):
        return np.asarray(render(reference, scale=SCALE).convert("L")) < 160, "line-art"
    return extract_lines(reference)


# ---------------------------------------------------------------- user ink

def is_scored(stroke: dict) -> bool:
    """Whether a stroke counts: its layer's `scored` flag, or for older clients, a Sketch or Line stroke.

    Shading (`shade`) is tone, not line, so it never counts: a broad pencil band would read as misses. Paint-bucket
    fills (`tool: "fill"`) are colour, not line, and never count either.
    """
    if stroke.get("shade") is True or stroke.get("tool") == "fill":
        return False
    scored = stroke.get("scored")
    if isinstance(scored, bool):
        return scored
    return stroke.get("layer") in SCORED_LAYERS


def scored_strokes(strokes: list[dict]) -> list[list[tuple[float, float]]]:
    """The (x, y) paper points of every scored stroke."""
    result = []
    for stroke in strokes or []:
        if not is_scored(stroke):
            continue
        points = [(float(p[0]), float(p[1])) for p in stroke.get("points", []) if len(p) >= 2
                  and math.isfinite(float(p[0])) and math.isfinite(float(p[1]))]
        if points:
            result.append(points)
    return result


def rasterize(strokes: list[list[tuple[float, float]]], transform: Transform | None = None) -> np.ndarray:
    image = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(image)
    transform = transform or Transform()
    for points in strokes:
        pts = [tuple(v * SCALE for v in transform.forward(x, y)) for x, y in points]
        if len(pts) == 1:
            x, y = pts[0]
            draw.ellipse([x - 1, y - 1, x + 1, y + 1], fill=255)
        else:
            draw.line(pts, fill=255, width=USER_WIDTH, joint="curve")
    return np.asarray(image) > 0


def credit(distance: np.ndarray) -> np.ndarray:
    """1 within the tolerance, fading to 0 a little further out, so near misses still earn something."""
    return np.clip(1 - (distance - TOLERANCE) / FALLOFF, 0.0, 1.0)


def envelope(mask: np.ndarray) -> np.ndarray:
    """Ink widened evenly in every direction, so line thickness and raster quirks do not skew the moments."""
    return ndimage.distance_transform_edt(~mask) <= TOLERANCE


def moments(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Centroid (x, y) and standard deviation (x, y) of the ink, in score pixels."""
    ys, xs = np.nonzero(mask)
    if len(xs) < 2:
        return None
    return np.array([xs.mean(), ys.mean()]), np.array([xs.std(), ys.std()])


def framing(points: list[list[tuple[float, float]]]) -> Transform:
    """The paper reaches past the scoring frame. For a drawing made partly or wholly outside it, a transform that
    brings it inside (centred, shrunk to fit if needed) so alignment can see it; the identity otherwise."""
    xs = [x for stroke in points for x, _ in stroke]
    ys = [y for stroke in points for _, y in stroke]
    if not xs:
        return Transform()
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if x0 >= 0 and y0 >= 0 and x1 <= PAPER_W and y1 <= PAPER_H:
        return Transform()
    scale = min(1.0, 0.9 * PAPER_W / max(x1 - x0, 1e-6), 0.9 * PAPER_H / max(y1 - y0, 1e-6))
    return Transform(scale, ((x0 + x1) / 2, (y0 + y1) / 2), (PAPER_W / 2, PAPER_H / 2))


def alignment(user: np.ndarray, ref: np.ndarray) -> Transform:
    """Uniform scale + translation that puts the user's ink centroid and overall spread onto the reference's."""
    mu, mr = moments(user), moments(ref)
    if mu is None or mr is None:
        return Transform()
    spread_user, spread_ref = math.hypot(*mu[1]), math.hypot(*mr[1])
    if spread_user < 1e-6:
        return Transform()
    scale = spread_ref / spread_user
    return Transform(scale, tuple(mu[0] / SCALE), tuple(mr[0] / SCALE))


# ---------------------------------------------------------------- scores

def proportion_score(user: np.ndarray, ref: np.ndarray, aligned: bool) -> tuple[float, dict]:
    mu, mr = moments(user), moments(ref)
    if mu is None or mr is None:
        return 0.0, {}
    su, sr = mu[1] + 1.0, mr[1] + 1.0  # +1 keeps a perfectly straight line from dividing by zero
    aspect_error = abs(math.log((su[0] / su[1]) / (sr[0] / sr[1])))
    size_error = 0.0 if aligned else abs(math.log(math.hypot(*su) / math.hypot(*sr)))
    error = max(0.0, aspect_error + 0.5 * size_error - PROPORTION_SLACK)
    detail = {"width_ratio": round(float(su[0] / sr[0]), 3), "height_ratio": round(float(su[1] / sr[1]), 3),
              "aspect_error": round(aspect_error, 3), "size_error": round(size_error, 3)}
    return round(10 * max(0.0, 1 - error / PROPORTION_ZERO), 1), detail


def regions(mask: np.ndarray, transform: Transform, prefix: str, kind: str) -> list[dict]:
    """Bounding boxes (in the person's paper coordinates) of the larger blobs in ``mask``."""
    if not mask.any():
        return []
    labels, count = ndimage.label(ndimage.binary_dilation(mask, iterations=4))
    found = []
    for index, box in enumerate(ndimage.find_objects(labels), start=1):
        pixels = int(np.count_nonzero(mask[box] & (labels[box] == index)))
        if pixels < MIN_REGION:
            continue
        y0, y1, x0, x1 = box[0].start, box[0].stop, box[1].start, box[1].stop
        a = transform.inverse(x0 / SCALE, y0 / SCALE)
        b = transform.inverse(x1 / SCALE, y1 / SCALE)
        found.append({"kind": kind, "pixels": pixels,
                      "box": [round(min(a[0], b[0])), round(min(a[1], b[1])), round(max(a[0], b[0])), round(max(a[1], b[1]))]})
    found.sort(key=lambda item: -item["pixels"])
    for number, item in enumerate(found[:MAX_REGIONS], start=1):
        item["id"] = f"{prefix}{number}"
    return found[:MAX_REGIONS]


def stroke_stats(strokes: list[dict]) -> dict:
    lengths, durations = [], []
    for stroke in strokes or []:
        if not is_scored(stroke):
            continue
        points = stroke.get("points", [])
        length = sum(math.dist(points[i][:2], points[i + 1][:2]) for i in range(len(points) - 1))
        lengths.append(length)
        if points and len(points[0]) >= 4 and len(points[-1]) >= 4:
            durations.append(max(0.0, float(points[-1][3]) - float(points[0][3])))
    count = len(lengths)
    return {"stroke_count": count,
            "mean_length": round(sum(lengths) / count, 1) if count else 0.0,
            "short_share": round(sum(1 for value in lengths if value < SHORT_STROKE) / count, 2) if count else 0.0,
            "mean_duration_ms": round(sum(durations) / len(durations)) if durations else 0}


def where(box) -> str:
    """Where a region sits on the paper, in words: "in the top left", "in the middle", "in the bottom middle"."""
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    row = "top" if cy < PAPER_H / 3 else "bottom" if cy > 2 * PAPER_H / 3 else ""
    column = "left" if cx < PAPER_W / 3 else "right" if cx > 2 * PAPER_W / 3 else ""
    if row and column:
        return f"in the {row} {column}"
    if row or column:
        return f"in the {row or column} middle" if row else f"on the {column}"
    return "in the middle"


def next_step(reference: Reference | None, user: np.ndarray, near_user: np.ndarray, misses: list[dict]) -> dict | None:
    """What to draw next in level 1: the first built-in step not yet covered, or the biggest missed region."""
    if reference is not None:
        for index, step in enumerate(reference.steps):
            mask = centre_line(np.asarray(render(reference, steps=[index], scale=SCALE).convert("L")) < 160)
            total = np.count_nonzero(mask)
            covered = np.count_nonzero(mask & near_user) / total if total else 1.0
            if covered < 0.8:
                return {"index": index, "text": step.text, "box": [round(v) for v in step.box()], "covered": round(float(covered), 2)}
        return {"index": len(reference.steps), "text": "Every part is covered. Go over any wobbly line once more, or submit.",
                "box": None, "covered": 1.0}
    if misses:
        return {"index": None, "text": f"Trace the lines {where(misses[0]['box'])} next.", "box": misses[0]["box"], "covered": None}
    return {"index": None, "text": "Every line is covered. Look for spots where your line drifted away.", "box": None, "covered": None}


def score(reference: Reference | Image.Image, strokes: list[dict], level: int) -> dict:
    """The full machine score for one drawing."""
    ref_ink, method = reference_mask(reference)
    ref_line = centre_line(ref_ink)
    points = scored_strokes(strokes)
    stats = stroke_stats(strokes)
    builtin = reference if isinstance(reference, Reference) else None
    if not ref_line.any():
        return {"shape": 0.0, "proportion": 0.0, "overall": 0.0, "recall": 0.0, "precision": 0.0, "method": method,
                "aligned": False, "transform": Transform().as_dict(), "misses": [], "strays": [], "stats": stats,
                "next_step": None, "warning": "no lines were found in the reference"}
    transform = Transform()
    aligned = level in ALIGNED_LEVELS
    near_ref = envelope(ref_ink)
    if aligned:
        transform = framing(points)
    user = rasterize(points, transform)
    if aligned and user.any():
        transform = transform.then(alignment(envelope(user), near_ref))
        user = rasterize(points, transform)
    if not user.any():
        misses = regions(ref_line, transform, "M", "missing")
        return {"shape": 0.0, "proportion": 0.0, "overall": 0.0, "recall": 0.0, "precision": 0.0, "method": method,
                "aligned": aligned, "transform": transform.as_dict(), "misses": misses, "strays": [], "stats": stats,
                "next_step": next_step(builtin, user, np.zeros_like(user), misses) if level == 1 else None}
    near_user = envelope(user)
    to_user = ndimage.distance_transform_edt(~user)
    to_ref = ndimage.distance_transform_edt(~ref_ink)
    recall = float(credit(to_user[ref_line]).mean())
    precision = float(credit(to_ref[user]).mean())
    f_score = 2 * recall * precision / (recall + precision) if recall + precision else 0.0
    shape = round(10 * min(1.0, f_score / F_FOR_TEN), 1)
    proportion, detail = proportion_score(near_user, near_ref, aligned)
    misses = regions(ref_line & (to_user > MISS_DISTANCE), transform, "M", "missing")
    strays = regions(user & (to_ref > MISS_DISTANCE), transform, "S", "stray")
    return {"shape": shape, "proportion": proportion, "overall": round((shape + proportion) / 2, 1),
            "recall": round(recall, 3), "precision": round(precision, 3), "f_score": round(f_score, 3),
            "method": method, "aligned": aligned, "transform": transform.as_dict(), "proportion_detail": detail,
            "misses": misses, "strays": strays, "stats": stats,
            "next_step": next_step(builtin, user, near_user, misses) if level == 1 else None}
