"""The drawing assistant: tell Claude an idea in the chat and it draws it, like a CAD helper.

Claude answers with a short reply and a list of geometric shapes (lines, circles, ellipses, arcs, curves...) in paper
coordinates. This module turns the shapes into plain point lists, so the browser can add them as ordinary strokes on
a "Claude" layer, which never counts towards the score. The person keeps drawing by hand wherever they want to.

Claude sees two images: the sheet with a coordinate grid, the reference (faint red) and everything drawn so far, and
the reference alone. It is reached the same two ways as the coach (``claude`` command line, or the Messages API).
"""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from drawing_room import coach as coach_module
from drawing_room.references import PAPER_H, PAPER_W, png_bytes

DRAWING_FILE = "drawing.png"
REFERENCE_FILE = "reference.png"
MAX_MESSAGE = 1500
MAX_HISTORY = 12
MAX_SHAPES = 200
MAX_POINTS = 40000
COORD_LIMIT = 6000
STEP = 3.0  # paper units between sampled points
STYLES = ("line", "construction")

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
Every shape may add "style": "line" (finished dark line, the default) or "construction" (light blue guide line the
person draws over and later hides), and "color": "#rrggbb" for a coloured line.
Use construction lines for guides, axes, boxes and perspective lines; use line for what should look finished.
Set "clear_previous": true only when the person asks you to redo or remove what you drew before.
When the person only asks a question, answer with "shapes": []. Use at most 150 shapes."""


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
        strokes.append({"style": style, "color": color,
                        "points": [[round(x, 1), round(y, 1)] for x, y in points]})
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


def drawing_image(reference: Image.Image | None, strokes: list[dict], sheet) -> Image.Image:
    """The sheet with a labelled grid, the reference frame and reference (faint red), and every stroke so far."""
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
    for stroke in strokes or []:
        points = [at(float(p[0]), float(p[1])) for p in stroke.get("points", []) if len(p) >= 2]
        color = (70, 130, 220) if stroke.get("assistant") else (30, 30, 30)
        if len(points) == 1:
            x, y = points[0]
            draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=color)
        elif points:
            draw.line(points, fill=color, width=2, joint="curve")
    return image


def build_prompt(message: str, history: list[dict], sheet, level: int, reference_name: str | None,
                 image_note: str) -> str:
    x0, y0, x1, y1 = sheet
    parts = [
        f"Level: {coach_module.LEVEL_NAMES.get(level, level)}",
        f"Reference: {reference_name or 'none'}",
        f"Sheet bounds: x {x0:g} to {x1:g}, y {y0:g} to {y1:g}. Reference frame: x 0 to {PAPER_W}, y 0 to {PAPER_H}.",
        image_note,
        "In drawing.png the person's strokes are black and the shapes you drew before are blue.",
    ]
    turns = [turn for turn in history[-MAX_HISTORY:] if isinstance(turn, dict) and turn.get("text")]
    if turns:
        parts += ["", "The conversation so far:"]
        for turn in turns:
            who = "You" if turn.get("role") == "assistant" else "Person"
            parts.append(f"{who}: {str(turn['text'])[:MAX_MESSAGE]}")
    parts += ["", f"The person says now: {message}", "", "Answer with the JSON object only."]
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
           api_client=None) -> dict:
    """Ask Claude to draw or advise. Returns ``{reply, strokes, clear_previous, skipped, route}``."""
    message = (message or "").strip()[:MAX_MESSAGE]
    if not message:
        raise AssistError("say what you would like Claude to draw or explain")
    sheet = parse_sheet(sheet)
    images = {DRAWING_FILE: png_bytes(drawing_image(reference_image, strokes, sheet))}
    if reference_image is not None:
        images[REFERENCE_FILE] = png_bytes(reference_image.convert("RGB"))
    history = history if isinstance(history, list) else []
    if api_client is not None or coach_module.use_api():
        if api_client is None:
            import anthropic

            api_client = anthropic.Anthropic()
        note = "The images are attached: " + ", ".join(images) + "."
        text, route = _ask_api(build_prompt(message, history, sheet, level, reference_name, note), images,
                               api_client), "api"
    else:
        workdir = Path(tempfile.mkdtemp(prefix="drawing-room-assist-"))
        try:
            for name, data in images.items():
                (workdir / name).write_bytes(data)
            note = "Read " + " and ".join(str(workdir / name) for name in images) + " before answering."
            try:
                text = coach_module.ask_cli(build_prompt(message, history, sheet, level, reference_name, note),
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
