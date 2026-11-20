"""The drawing assistant: tell Claude an idea in the chat and it draws it, like a CAD helper.

Claude answers with a short reply and a list of geometric shapes (lines, circles, ellipses, arcs, curves...) in paper
coordinates. This module turns the shapes into plain point lists, so the browser can add them as ordinary strokes on
a "Claude" layer, which never counts towards the score. The person keeps drawing by hand wherever they want to.

Claude sees two images: the sheet with a coordinate grid, the reference (faint red) and everything drawn so far, and
the reference alone. It is reached the same two ways as the coach (``claude`` command line, or the Messages API).
"""

from __future__ import annotations

import json
import base64
import io
import math
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from drawing_room import coach as coach_module
from drawing_room.references import MAX_IMAGE_PIXELS, PAPER_H, PAPER_W, png_bytes

DRAWING_FILE = "drawing.png"
REFERENCE_FILE = "reference.png"
MAX_MESSAGE = 1500
MAX_NOTES = 12  # spots the person can pin on the drawing for one message
MAX_NOTE = 300  # characters per note
MAX_ATTACHMENTS = 4  # pictures the person can attach to one chat message
ATTACHMENT_SIDE = 1600  # pixels: attached pictures are scaled down to fit this square
MAX_HISTORY = 12
MAX_SHAPES = 200
MAX_POINTS = 40000
COORD_LIMIT = 6000
STEP = 3.0  # paper units between sampled points
STYLES = ("line", "construction")
MAX_LAYER_NAME = 24
MAX_LABEL = 80  # characters in a label Claude writes on the drawing
LABEL_SIZES = (10.0, 48.0, 18.0)  # smallest, largest and default text height, paper units
ALIGNS = ("left", "center", "right")
FILLABLE = ("rect", "circle", "ellipse")  # plus a closed polyline

SYSTEM_PROMPT = """You are a drawing assistant inside a hand-drawing practice app, a bit like the helper in a CAD
program. The person tells you an idea ("draw a box in two-point perspective", "add a centre line", "sketch the cap of
the mushroom") and you draw it for them as geometric shapes, or you give advice when they ask a question. They draw by
hand wherever they want to and ask you for the rest.

Reply in the same language the person writes in. Keep the reply short (at most about 80 words), plain text, no markdown.

Coordinates are paper units: x to the right, y DOWN, origin at the top left of the reference frame, which is
1000 x 750. The sheet can be bigger than the frame (its bounds are given). The image drawing.png shows the sheet with a
grid line every 50 units and labels every 100, so read positions off the grid. Place shapes where they make sense for
what is already drawn and for the reference. Never draw outside the sheet.

Always answer with ONE JSON object and nothing else:
{"reply": "...", "shapes": [ ... ], "clear_previous": false}

Shapes (all numbers in paper units, angles in degrees, clockwise because y points down):
- {"type": "line", "a": [x, y], "b": [x, y]}
- {"type": "polyline", "points": [[x, y], ...], "closed": false}
- {"type": "rect", "x": x, "y": y, "w": w, "h": h, "rotation": 0}
- {"type": "circle", "c": [x, y], "r": r}
- {"type": "ellipse", "c": [x, y], "rx": rx, "ry": ry, "rotation": 0}
- {"type": "arc", "c": [x, y], "rx": rx, "ry": ry, "start": 0, "end": 180, "rotation": 0}
- {"type": "bezier", "points": [p0, c1, c2, p3, c4, c5, p6, ...]}  (cubic segments joined end to end)
- {"type": "label", "at": [x, y], "text": "...", "size": 18, "align": "left"}  (text written on the drawing: "at" is
  the middle of its first line's left end, or its centre / right end with "align"; "size" is the letter height, 10 to
  48; at most 80 characters, "\\n" for up to 3 lines; "color" works as for lines. It is real text: never draw
  letters or digits out of lines.)
Every shape may add "style": "line" (finished dark line, the default) or "construction" (light blue guide line the
person draws over and later hides), and "color": "#rrggbb" for a coloured line.
Use construction lines for guides, axes, boxes and perspective lines; use line for what should look finished.
A shape may set its line "width" (0.5 to 8 paper units; default 1.6 for construction, 2.6 for line), its
"opacity" (0.1 to 1, default 1) and "dash": true for a dashed line.
Every shape may also add "layer": "<name>" to go on a layer of yours with that name (made the first time, reused
after, never scored; without it the shape goes on your layer "Claude"), and "fill": true to paint a closed shape
(rect, circle, ellipse, closed polyline) as a solid area in its colour instead of an outline. Layers are stacked
in the order you first use them, the first one lowest.
Set "clear_previous": true only when the person asks you to redo or remove what you drew before; it empties every
layer of yours.
When the person only asks a question, answer with "shapes": []. Use at most 150 shapes.

EXPLAIN ON THE DRAWING. When you draw something to teach it, or explain points of a drawing, write the explanation
onto the picture so the student does not have to look back and forth between the chat and the paper:
- A short label (at most 6 words) beside every point that matters: each vanishing point ("Điểm tụ trái"), the horizon,
  the nearest corner, a corner you construct ("Góc sau: 2 tia cắt nhau"), a light source, a shadow point. Put it just
  beside the point, never over a line, and give it a thin leader line (width 1, opacity 0.6) when it sits further off.
- Number the construction in the order to draw it: a bold number ("1", "2", …, size 22) next to each line or point of
  that step, and a few words after it ("1 Kẻ chân trời"). The same colour as the lines it explains.
- Labels go on a layer of yours called "Notes", emitted last so they sit on top. Dark text "#1f2328", or the colour of
  what they name. Keep them inside the sheet and apart from one another.
- Then the reply refers to the numbers ("bước 2: …") instead of describing positions again.

PERSPECTIVE ILLUSTRATIONS. When the person asks you to draw a perspective illustration (a box in 1, 2 or 3-point
perspective, a horizon, vanishing points), the student must be able to read it at a glance, and hiding the layer
"Sketch" must leave a clean box while showing it again reveals the whole construction:
- ONE box and ONE horizon per illustration. Never several boxes in one picture: if they want several cases, draw one
  now and offer the next. A new illustration replaces the previous one ("clear_previous": true).
- Four weights of line, from faint to strong, on three layers. Emit the shapes in this order (lowest layer first):
  1. Layer "Sketch", the skeleton: the horizon and every construction line to a vanishing point. "width": 1,
     "opacity": 0.4, "dash": true, style "construction". The horizon "#9a9a9a"; lines to the left or right vanishing
     point "#e8a33d" (orange); lines to the vertical (third) vanishing point "#4a90e2" (blue). A small filled dot
     (circle r 5, "fill": true, "opacity": 0.7, color "#555555") on each vanishing point. Hidden edges of the box,
     if you show them at all, go here too, dashed.
  2. Layer "Sketch", the finding lines, after the skeleton: "width": 1, "opacity": 0.7, solid, coloured by role.
     To find the hidden back corner of the top (or bottom) face, draw the line from the far-left corner to the RIGHT
     vanishing point and from the far-right corner to the LEFT vanishing point in "#2e9e5b" (green): they meet at the
     back corner; put a small filled green dot (r 4) there. These are not the face's diagonals. Depth-dividing
     diagonals are green too.
  3. Layer "Color", the faces: each visible face as a closed polyline with "fill": true and "opacity": 0.6, one fixed
     colour per face: left face "#8b7fd6" (purple), right face "#f08a6c" (coral), top or bottom face "#6cc287"
     (green), and in one-point perspective the front face "#b9b3e8".
  4. Layer "Line", the main lines, last so they sit on top: the box's VISIBLE edges only, solid, style "line",
     "opacity": 1, color "#1f2328". "width": 2 for the far edges, 2.5 for the edges nearest the eye (the nearest
     vertical and the edges meeting it). Never draw a hidden edge on this layer.
- Construct it, do not guess: compute every corner as the intersection of lines to the vanishing points.
  One-point: the front face is a true square; join its corners to the vanishing point and cut the back face at a
  depth, parallel to the front. Two-point: vanishing points far apart at both ends of the horizon; draw the nearest
  vertical edge, run both its ends to both vanishing points, place the two far verticals, and find the back corner
  as above; verticals stay vertical. Three-point: as two-point plus a third vanishing point straight below the box
  (seen from above) or above it (seen from below); the verticals all converge on it and the box tapers toward it.
- A box below the horizon shows its top face; above the horizon, its bottom face. Left of a one-point vanishing point
  it shows its right face, right of it its left face.
- Then the reply is exactly four short sentences (at most 20 words each), in the person's language: whether the
  horizon is high or low and which face shows; which colour of construction line goes to which vanishing point;
  which face is filled with which colour; how to redraw the first step by hand."""


class AssistError(RuntimeError):
    """The assistant could not answer; the message is safe to show to the person."""


# ---------------------------------------------------------------- shapes to points

def _number(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a number")
    if abs(value) > COORD_LIMIT:
        raise ValueError(f"{name} is out of range")
    return float(value)


def _point(value, name: str) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        raise ValueError(f"{name} must be [x, y]")
    return _number(value[0], f"{name}.x"), _number(value[1], f"{name}.y")


def _densify(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Add points along straight runs, so a long line still has points every few units (the eraser hits them)."""
    if len(points) < 2:
        return points
    out = [points[0]]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        steps = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / STEP))
        out += [(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps) for i in range(1, steps + 1)]
    return out


def _ellipse(cx, cy, rx, ry, rotation, start, end) -> list[tuple[float, float]]:
    cos_r, sin_r = math.cos(math.radians(rotation)), math.sin(math.radians(rotation))
    sweep = end - start
    steps = max(8, math.ceil(abs(math.radians(sweep)) * max(rx, ry) / STEP))
    points = []
    for i in range(steps + 1):
        t = math.radians(start + sweep * i / steps)
        x, y = rx * math.cos(t), ry * math.sin(t)
        points.append((cx + x * cos_r - y * sin_r, cy + x * sin_r + y * cos_r))
    return points


def _bezier(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if len(points) < 4 or (len(points) - 1) % 3:
        raise ValueError("a bezier needs 4, 7, 10... points (cubic segments)")
    out = [points[0]]
    for i in range(0, len(points) - 1, 3):
        p0, p1, p2, p3 = points[i:i + 4]
        length = sum(math.dist(a, b) for a, b in zip((p0, p1, p2), (p1, p2, p3)))
        steps = max(4, math.ceil(length / STEP))
        for k in range(1, steps + 1):
            t = k / steps
            u = 1 - t
            out.append(tuple(u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * d
                             for a, b, c, d in zip(p0, p1, p2, p3)))
    return out


def shape_points(shape: dict) -> list[tuple[float, float]]:
    """The points along one shape. Raises ValueError for a shape that cannot be drawn."""
    if not isinstance(shape, dict):
        raise ValueError("a shape must be an object")
    kind = shape.get("type")
    rotation = _number(shape.get("rotation", 0), "rotation")
    if kind == "line":
        return _densify([_point(shape.get("a"), "a"), _point(shape.get("b"), "b")])
    if kind == "polyline":
        raw = shape.get("points")
        if not isinstance(raw, list) or len(raw) < 2:
            raise ValueError("a polyline needs at least 2 points")
        points = [_point(p, "point") for p in raw]
        if shape.get("closed"):
            points.append(points[0])
        return _densify(points)
    if kind == "rect":
        x, y = _number(shape.get("x"), "x"), _number(shape.get("y"), "y")
        w, h = _number(shape.get("w"), "w"), _number(shape.get("h"), "h")
        cx, cy = x + w / 2, y + h / 2
        cos_r, sin_r = math.cos(math.radians(rotation)), math.sin(math.radians(rotation))
        corners = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
        turned = [(cx + (px - cx) * cos_r - (py - cy) * sin_r, cy + (px - cx) * sin_r + (py - cy) * cos_r)
                  for px, py in corners]
        return _densify(turned)
    if kind in ("circle", "ellipse", "arc"):
        cx, cy = _point(shape.get("c"), "c")
        if kind == "circle":
            rx = ry = _number(shape.get("r"), "r")
        else:
            rx = _number(shape.get("rx", shape.get("r")), "rx")
            ry = _number(shape.get("ry", shape.get("r")), "ry")
        if rx <= 0 or ry <= 0:
            raise ValueError("radii must be positive")
        start, end = (0.0, 360.0) if kind != "arc" else (_number(shape.get("start", 0), "start"),
                                                          _number(shape.get("end", 180), "end"))
        return _ellipse(cx, cy, rx, ry, rotation, start, end)
    if kind == "label":
        _label_text(shape)
        return [_point(shape.get("at"), "at")]
    if kind == "bezier":
        raw = shape.get("points")
        if not isinstance(raw, list):
            raise ValueError("a bezier needs points")
        return _bezier([_point(p, "point") for p in raw])
    raise ValueError(f"unknown shape type {kind!r}")


def _style(shape: dict) -> tuple[str, str | None]:
    style = shape.get("style") if shape.get("style") in STYLES else "line"
    color = shape.get("color")
    color = color if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color) else None
    return style, color


def _layer_name(value) -> str | None:
    """A layer name Claude gave: one line, trimmed, at most MAX_LAYER_NAME characters, or None."""
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())[:MAX_LAYER_NAME].strip()
    return name or None


def _label_text(shape: dict) -> str:
    """A label's text: at most 3 lines and MAX_LABEL characters. Raises ValueError when it is empty."""
    raw = shape.get("text")
    if not isinstance(raw, str):
        raise ValueError("a label needs text")
    lines = [" ".join(line.split()) for line in raw.replace("\\n", "\n").split("\n")]
    text = "\n".join(line for line in lines if line)[:MAX_LABEL]
    lines = text.split("\n")[:3]
    if not "".join(lines):
        raise ValueError("a label needs text")
    return "\n".join(lines)


def _line_look(shape: dict) -> dict:
    """The optional width, opacity and dash of a shape, kept only when they make sense."""
    look = {}
    for key, low, high in (("width", 0.5, 8.0), ("opacity", 0.1, 1.0)):
        value = shape.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            look[key] = round(min(high, max(low, float(value))), 2)
    if shape.get("dash") is True:
        look["dash"] = True
    return look


def _closed(shape: dict) -> bool:
    """Whether a shape encloses an area that can be filled."""
    return shape.get("type") in FILLABLE or (shape.get("type") == "polyline" and shape.get("closed") is True)


def shapes_to_strokes(shapes) -> tuple[list[dict], list[str]]:
    """Strokes ``{style, color, points}`` for the browser, and a note for each shape that was skipped."""
    if not isinstance(shapes, list):
        return [], ["shapes was not a list"]
    strokes, skipped, total = [], [], 0
    for index, shape in enumerate(shapes[:MAX_SHAPES]):
        try:
            points = shape_points(shape)
        except ValueError as bad:
            skipped.append(f"shape {index + 1}: {bad}")
            continue
        total += len(points)
        if total > MAX_POINTS:
            skipped.append("too many points; the rest was left out")
            break
        style, color = _style(shape)
        stroke = {"style": style, "color": color, "points": [[round(x, 1), round(y, 1)] for x, y in points]}
        layer = _layer_name(shape.get("layer"))
        if layer:
            stroke["layer"] = layer
        if shape.get("fill") is True and _closed(shape):
            stroke["fill"] = True
        stroke.update(_line_look(shape))
        if shape.get("type") == "label":
            low, high, default = LABEL_SIZES
            size = shape.get("size")
            ok = isinstance(size, (int, float)) and not isinstance(size, bool) and math.isfinite(size)
            stroke.update(text=_label_text(shape), size=round(min(high, max(low, float(size))), 1) if ok else default,
                          align=shape.get("align") if shape.get("align") in ALIGNS else "left")
            stroke.pop("width", None)
            stroke.pop("dash", None)
        strokes.append(stroke)
    if len(shapes) > MAX_SHAPES:
        skipped.append(f"only the first {MAX_SHAPES} shapes were drawn")
    return strokes, skipped


# ---------------------------------------------------------------- Claude's answer

def parse_answer(text: str) -> dict:
    """The JSON object in Claude's answer. Falls back to the plain text as the reply when there is no JSON."""
    text = (text or "").strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    candidates = [fenced.group(1)] if fenced else []
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        candidates.append(text[start:end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return {"reply": str(value.get("reply") or "").strip(), "shapes": value.get("shapes") or [],
                    "clear_previous": value.get("clear_previous") is True}
    return {"reply": text, "shapes": [], "clear_previous": False}


# ---------------------------------------------------------------- what Claude sees

def parse_sheet(sheet) -> tuple[float, float, float, float]:
    """The sheet bounds [x0, y0, x1, y1] in paper units; the reference frame when missing or odd."""
    try:
        x0, y0, x1, y1 = (float(v) for v in sheet)
    except (TypeError, ValueError):
        return 0.0, 0.0, float(PAPER_W), float(PAPER_H)
    if not all(math.isfinite(v) and abs(v) <= COORD_LIMIT for v in (x0, y0, x1, y1)) or x1 - x0 < 10 or y1 - y0 < 10:
        return 0.0, 0.0, float(PAPER_W), float(PAPER_H)
    return x0, y0, x1, y1


def parse_notes(raw) -> list[dict]:
    """Notes pinned on the drawing: ``[{x, y, text}]`` in paper units. Raises ValueError for anything else."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_NOTES:
        raise ValueError(f"pin at most {MAX_NOTES} notes to a message")
    notes = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("each note is {x, y, text}")
        x, y = _number(item.get("x"), "x"), _number(item.get("y"), "y")
        text = " ".join(str(item.get("text") or "").split())[:MAX_NOTE]
        if not text:
            raise ValueError("a note needs some text")
        notes.append({"x": x, "y": y, "text": text})
    return notes


def drawing_image(reference: Image.Image | None, strokes: list[dict], sheet, notes: list[dict] | None = None) -> Image.Image:
    """The sheet with a labelled grid, the reference frame and reference (faint red), every stroke so far, and the
    person's notes as numbered orange pins."""
    x0, y0, x1, y1 = sheet
    scale = min(1.0, 1200 / max(x1 - x0, y1 - y0))
    size = (max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale)))
    image = Image.new("RGB", size, "white")

    def at(x, y):
        return (x - x0) * scale, (y - y0) * scale

    if reference is not None:
        gray = reference.convert("L").resize((max(1, round(PAPER_W * scale)), max(1, round(PAPER_H * scale))))
        mask = gray.point(lambda v: int(max(0, 200 - v) * 0.6))
        red = Image.new("RGB", gray.size, (240, 120, 120))
        image.paste(red, tuple(round(v) for v in at(0, 0)), mask=mask)
    draw = ImageDraw.Draw(image)
    for gx in range(math.ceil(x0 / 50) * 50, math.floor(x1) + 1, 50):
        major = gx % 100 == 0
        draw.line([at(gx, y0), at(gx, y1)], fill=(200, 215, 235) if major else (232, 238, 246), width=1)
        if major:
            draw.text((at(gx, y0)[0] + 2, 2), str(gx), fill=(90, 120, 170))
    for gy in range(math.ceil(y0 / 50) * 50, math.floor(y1) + 1, 50):
        major = gy % 100 == 0
        draw.line([at(x0, gy), at(x1, gy)], fill=(200, 215, 235) if major else (232, 238, 246), width=1)
        if major:
            draw.text((2, at(x0, gy)[1] + 2), str(gy), fill=(90, 120, 170))
    draw.rectangle([at(0, 0), at(PAPER_W, PAPER_H)], outline=(150, 150, 150), width=1)
    # Filled areas (Claude's painted faces) first, pale, so every line stays readable on top of them.
    for stroke in strokes or []:
        points = [at(float(p[0]), float(p[1])) for p in stroke.get("points", []) if len(p) >= 2]
        if stroke.get("fill") is True and len(points) >= 3:
            draw.polygon(points, fill=(205, 222, 245) if stroke.get("assistant") else (215, 215, 215))
    for stroke in strokes or []:
        text = stroke.get("text")
        points = stroke.get("points") or []
        if isinstance(text, str) and text and points and len(points[0]) >= 2:
            x, y = at(float(points[0][0]), float(points[0][1]))
            size = stroke.get("size") if isinstance(stroke.get("size"), (int, float)) else LABEL_SIZES[2]
            font = ImageFont.load_default(size=max(8, round(float(size) * scale)))
            anchor = {"center": "mm", "right": "rm"}.get(stroke.get("align"), "lm")
            draw.multiline_text((x, y), text[:MAX_LABEL], font=font, anchor=anchor if "\n" not in text else "la",
                                fill=(70, 130, 220) if stroke.get("assistant") else (30, 30, 30))
    for stroke in strokes or []:
        if stroke.get("fill") is True or stroke.get("text"):
            continue
        points = [at(float(p[0]), float(p[1])) for p in stroke.get("points", []) if len(p) >= 2]
        color = (70, 130, 220) if stroke.get("assistant") else (30, 30, 30)
        if len(points) == 1:
            x, y = points[0]
            draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=color)
        elif points:
            draw.line(points, fill=color, width=2, joint="curve")
    for number, note in enumerate(notes or [], start=1):
        x, y = at(note["x"], note["y"])
        draw.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(240, 120, 30), outline=(255, 255, 255), width=2)
        draw.text((x, y), str(number), fill=(255, 255, 255), anchor="mm")
    return image


def prepare_attachment(data_url) -> bytes:
    """A picture attached in the chat (a ``data:image/...;base64,`` URL): checked, flattened onto white and scaled
    to at most ATTACHMENT_SIDE pixels a side, as PNG. Raises ValueError when it is not a picture we can read."""
    if not isinstance(data_url, str) or not data_url.startswith("data:image/") or "," not in data_url:
        raise ValueError("send a picture as a data:image URL")
    try:
        image = Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1], validate=False)))
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ValueError("the picture is too large")
        image.load()
    except ValueError:
        raise
    except Exception:  # not an image, truncated, or a decompression bomb
        raise ValueError("it is not a picture that can be read") from None
    rgba = image.convert("RGBA")
    flat = Image.new("RGB", rgba.size, "white")
    flat.paste(rgba, mask=rgba.split()[3])
    flat.thumbnail((ATTACHMENT_SIDE, ATTACHMENT_SIDE))
    return png_bytes(flat)


def attachment_note(names: list[str]) -> str:
    if not names:
        return ""
    return (f" The person also attached {len(names)} picture{'s' if len(names) > 1 else ''} of their own: "
            + ", ".join(names) + ". Look at them: it may be a reference to draw from, a photo, or a drawing to "
            "comment on. They are not the sheet; only drawing.png shows the sheet.")


def build_prompt(message: str, history: list[dict], sheet, level: int, reference_name: str | None,
                 image_note: str, notes: list[dict] | None = None) -> str:
    x0, y0, x1, y1 = sheet
    parts = [
        f"Level: {coach_module.LEVEL_NAMES.get(level, level)}",
        f"Reference: {reference_name or 'none'}",
        f"Sheet bounds: x {x0:g} to {x1:g}, y {y0:g} to {y1:g}. Reference frame: x 0 to {PAPER_W}, y 0 to {PAPER_H}.",
        image_note,
        "In drawing.png the person's strokes are black and the shapes you drew before are blue (your filled areas pale blue).",
    ]
    turns = [turn for turn in history[-MAX_HISTORY:] if isinstance(turn, dict) and turn.get("text")]
    if turns:
        parts += ["", "The conversation so far:"]
        for turn in turns:
            who = "You" if turn.get("role") == "assistant" else "Person"
            parts.append(f"{who}: {str(turn['text'])[:MAX_MESSAGE]}")
    parts += ["", f"The person says now: {message}"]
    if notes:
        parts += ["", "They pinned notes on the drawing (numbered orange pins in drawing.png; paper units). Answer "
                      "each one about that spot, by its number:"]
        parts += [f"{n}. At x {note['x']:g}, y {note['y']:g}: {note['text']}" for n, note in enumerate(notes, start=1)]
    parts += ["", "Answer with the JSON object only."]
    return "\n".join(parts)


def _ask_api(prompt: str, images: dict[str, bytes], client) -> str:
    import base64

    content = []
    for name, data in images.items():
        content.append({"type": "text", "text": f"Image: {name}"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": base64.standard_b64encode(data).decode("ascii")}})
    content.append({"type": "text", "text": prompt})
    response = client.beta.messages.create(
        model=coach_module.API_MODEL, max_tokens=16000, system=SYSTEM_PROMPT,
        output_config={"effort": "medium"},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        messages=[{"role": "user", "content": content}],
    )
    if response.stop_reason == "refusal":
        raise AssistError("Claude declined this one")
    return "\n".join(block.text for block in response.content if block.type == "text").strip()


def assist(reference_image: Image.Image | None, reference_name: str | None, strokes: list[dict], sheet,
           level: int, message: str, history: list[dict] | None = None, runner=subprocess.run,
           api_client=None, attachments: list[bytes] | None = None, notes: list[dict] | None = None) -> dict:
    """Ask Claude to draw or advise. Returns ``{reply, strokes, clear_previous, skipped, route}``.

    ``attachments`` are PNG pictures the person attached to the message (see prepare_attachment)."""
    attachments = list(attachments or [])[:MAX_ATTACHMENTS]
    message = (message or "").strip()[:MAX_MESSAGE]
    notes = list(notes or [])[:MAX_NOTES]
    if not message and notes:
        message = "Look at the spots I pinned."
    if not message and attachments:
        message = "Here is a picture." if len(attachments) == 1 else "Here are some pictures."
    if not message:
        raise AssistError("say what you would like Claude to draw or explain")
    sheet = parse_sheet(sheet)
    images = {DRAWING_FILE: png_bytes(drawing_image(reference_image, strokes, sheet, notes))}
    if reference_image is not None:
        images[REFERENCE_FILE] = png_bytes(reference_image.convert("RGB"))
    attached = [f"attachment-{i}.png" for i in range(1, len(attachments) + 1)]
    images.update(zip(attached, attachments))
    history = history if isinstance(history, list) else []
    if api_client is not None or coach_module.use_api():
        if api_client is None:
            import anthropic

            api_client = anthropic.Anthropic()
        note = "The images are attached: " + ", ".join(images) + "." + attachment_note(attached)
        text, route = _ask_api(build_prompt(message, history, sheet, level, reference_name, note, notes), images,
                               api_client), "api"
    else:
        workdir = Path(tempfile.mkdtemp(prefix="drawing-room-assist-"))
        try:
            for name, data in images.items():
                (workdir / name).write_bytes(data)
            note = ("Read " + " and ".join(str(workdir / name) for name in images) + " before answering."
                    + attachment_note(attached))
            try:
                text = coach_module.ask_cli(build_prompt(message, history, sheet, level, reference_name, note, notes),
                                            workdir, runner, system_prompt=SYSTEM_PROMPT)
            except coach_module.CoachError as failure:
                raise AssistError(str(failure)) from None
            route = "claude-cli"
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
    answer = parse_answer(text)
    drawn, skipped = shapes_to_strokes(answer["shapes"])
    reply = answer["reply"] or ("Done." if drawn else "Claude returned no reply.")
    return {"reply": reply, "strokes": drawn, "clear_previous": answer["clear_previous"], "skipped": skipped,
            "route": route}
