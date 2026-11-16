"""The coach: Claude looks at an overlay of the drawing on the reference and explains what to fix.

The machine score is computed first, deterministically. Claude only explains it: it gets the numbers, the numbered
miss regions and the stroke stats, plus an overlay image, and is told never to invent scores or coordinates.

Two ways to reach Claude:
* the local ``claude`` command line (Claude Code), allowed to use only the Read tool, reading images from a temp dir;
* the Messages API with the images inline, when ``ANTHROPIC_API_KEY`` is set and the ``anthropic`` package is installed.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from drawing_room.references import PAPER_H, PAPER_W, png_bytes
from drawing_room.scoring import SCORED_LAYERS, Transform

COACH_TIMEOUT = 240
API_MODEL = "claude-opus-5-5"
OVERLAY_FILE = "overlay.png"
REFERENCE_FILE = "reference.png"
MAX_QUESTION = 1000

SYSTEM_PROMPT = """You are a warm, concrete drawing coach for a beginner who is learning to draw by hand.
Always answer in plain English, whatever other instructions you may have seen; no slang, no profanity.
You are given a machine score and an overlay image. The numbers and regions come from a deterministic program:
never invent, change or recompute scores, and never make up coordinates. Refer to problem areas only by their region
ids (M1, M2 for missing reference lines; S1, S2 for stray lines) or by plain words like "the top left".
You never draw; you explain what to fix and what to practise next. Keep it short: at most about 120 words, using
2-4 short bullet points or sentences. Do not use headings."""

LEVEL_NAMES = {
    0: "Warm-up drill (straight line, circle or ellipse between guide dots)",
    1: "Level 1: tracing over the reference with step-by-step guidance",
    2: "Level 2: tracing over the reference, coach only when asked",
    3: "Level 3: drawing from the reference beside the paper, no underlay; size and position are ignored",
    4: "Level 4: drawing from the reference with no underlay, reviewed only after submitting; size and position are ignored",
}


def overlay(reference: Image.Image, strokes: list[dict], result: dict) -> Image.Image:
    """Reference ink in faint red, the person's ink in black, missed and stray regions boxed in yellow.

    When the level aligned the drawing onto the reference, the ink and boxes are moved the same way, so the overlay
    shows what was actually compared."""
    t = result.get("transform") or {}
    transform = Transform(t.get("scale", 1.0), tuple(t.get("source", (0, 0))), tuple(t.get("target", (0, 0))))
    image = Image.new("RGB", (PAPER_W, PAPER_H), "white")
    gray = reference.convert("L").resize((PAPER_W, PAPER_H))
    red = Image.new("RGB", image.size, (240, 120, 120))
    # Darker reference pixels show more red; a photo becomes a faint red copy of itself.
    mask = gray.point(lambda v: int(max(0, 200 - v) * 0.9))
    image.paste(red, mask=mask)
    draw = ImageDraw.Draw(image)
    for stroke in strokes or []:
        if stroke.get("layer") not in SCORED_LAYERS:
            continue
        points = [transform.forward(float(p[0]), float(p[1])) for p in stroke.get("points", []) if len(p) >= 2]
        if len(points) == 1:
            x, y = points[0]
            draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill="black")
        elif points:
            draw.line(points, fill="black", width=3, joint="curve")
    for region in result.get("misses", []) + result.get("strays", []):
        (x0, y0), (x1, y1) = transform.forward(*region["box"][:2]), transform.forward(*region["box"][2:])
        color = (235, 190, 0) if region["kind"] == "missing" else (255, 140, 0)
        draw.rectangle([x0 - 4, y0 - 4, x1 + 4, y1 + 4], outline=color, width=4)
        draw.text((x0 - 2, max(0, y0 - 18)), region["id"], fill=(120, 90, 0))
    return image


def describe_regions(result: dict) -> str:
    lines = []
    for region in result.get("misses", []):
        lines.append(f"- {region['id']}: part of the reference with no line of yours near it")
    for region in result.get("strays", []):
        lines.append(f"- {region['id']}: a line of yours that is not near any reference line")
    return "\n".join(lines) or "- none"


def build_prompt(result: dict, level: int, question: str, reference_name: str, image_note: str) -> str:
    """The user message for the coach. ``image_note`` says where the images are (files or attached)."""
    stats = result.get("stats", {})
    detail = result.get("proportion_detail", {})
    step = result.get("next_step") or {}
    question = (question or "").strip()[:MAX_QUESTION] or "How did I do, and what should I fix first?"
    parts = [
        f"Level: {LEVEL_NAMES.get(level, level)}",
        f"Reference: {reference_name}",
        image_note,
        "",
        "Machine score (0-10, already final; do not change it):",
        f"- Shape: {result.get('shape')} (recall {result.get('recall')}: share of the reference covered; "
        f"precision {result.get('precision')}: share of the person's ink that is on the reference)",
        f"- Proportion: {result.get('proportion')} (width ratio {detail.get('width_ratio', 'n/a')}, "
        f"height ratio {detail.get('height_ratio', 'n/a')}; 1.0 means right)",
        f"- Overall: {result.get('overall')}",
        "",
        "Regions (boxed and labelled in yellow on the overlay):",
        describe_regions(result),
        "",
        f"Strokes: {stats.get('stroke_count', 0)} strokes, mean length {stats.get('mean_length', 0)} px, "
        f"{round(100 * stats.get('short_share', 0))}% are short scratchy strokes (under 25 px).",
    ]
    if step.get("text"):
        parts.append(f"The app's next step for this person: {step['text']}")
    if level == 4:
        parts.append("This is the final review after submitting: say what went well, the one or two biggest fixes, "
                     "and what to practise next.")
    parts += ["", f"The person asks: {question}"]
    return "\n".join(parts)


def _cli_command() -> list[str]:
    return (os.environ.get("DRAWING_ROOM_CLAUDE") or "claude").split()


def cli_arguments(command: list[str] | None = None) -> list[str]:
    """``claude -p`` restricted to the Read tool, without the user's own settings, hooks or MCP servers."""
    return [*(command or _cli_command()), "-p", "--output-format", "stream-json", "--verbose",
            "--allowedTools", "Read", "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch,Agent,NotebookEdit",
            "--setting-sources", "project", "--strict-mcp-config", "--append-system-prompt", SYSTEM_PROMPT]


def parse_stream(output: str) -> tuple[str, str | None]:
    """The final reply text from ``stream-json`` output, and an error if the run failed."""
    texts, result_text, error = [], None, None
    for line in output.splitlines():
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("type") == "assistant":
            for block in message.get("message", {}).get("content", []):
                if block.get("type") == "text" and block.get("text", "").strip():
                    texts.append(block["text"].strip())
        elif message.get("type") == "result":
            if message.get("is_error"):
                error = str(message.get("result") or message.get("subtype") or "the coach reported an error")
            elif isinstance(message.get("result"), str):
                result_text = message["result"].strip()
    return (result_text or (texts[-1] if texts else "")), error


def ask_cli(prompt: str, workdir: Path, runner=subprocess.run) -> str:
    try:
        completed = runner(cli_arguments(), input=prompt, cwd=workdir, capture_output=True, text=True,
                           timeout=COACH_TIMEOUT)
    except FileNotFoundError:
        raise CoachError("could not find the claude command; install and sign in to Claude Code, "
                         "or set ANTHROPIC_API_KEY") from None
    except subprocess.TimeoutExpired:
        raise CoachError(f"the coach took longer than {COACH_TIMEOUT} s") from None
    reply, error = parse_stream(completed.stdout)
    if error or (completed.returncode and not reply):
        raise CoachError(error or completed.stderr[-400:].strip() or f"claude exited with {completed.returncode}")
    if not reply:
        raise CoachError("the coach returned no reply")
    return reply


def ask_api(prompt: str, images: dict[str, bytes], client=None) -> str:
    """The Messages API path, with the PNGs attached inline."""
    if client is None:
        import anthropic  # optional dependency: `uv sync --extra api`

        client = anthropic.Anthropic()
    content = []
    for name, data in images.items():
        content.append({"type": "text", "text": f"Image: {name}"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": base64.standard_b64encode(data).decode("ascii")}})
    content.append({"type": "text", "text": prompt})
    response = client.beta.messages.create(
        model=API_MODEL, max_tokens=4000, system=SYSTEM_PROMPT,
        output_config={"effort": "low"},
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        messages=[{"role": "user", "content": content}],
    )
    if response.stop_reason == "refusal":
        raise CoachError("the coach declined to answer this one")
    reply = "\n".join(block.text for block in response.content if block.type == "text").strip()
    if not reply:
        raise CoachError("the coach returned no reply")
    return reply


class CoachError(RuntimeError):
    """The coach could not answer; the message is safe to show to the person."""


def use_api() -> bool:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return True


def coach(reference_image: Image.Image, reference_name: str, strokes: list[dict], result: dict, level: int,
          question: str, runner=subprocess.run, api_client=None) -> dict:
    """Ask Claude about one scored drawing. Returns the reply and which route answered."""
    images = {OVERLAY_FILE: png_bytes(overlay(reference_image, strokes, result)),
              REFERENCE_FILE: png_bytes(reference_image.convert("RGB"))}
    if api_client is not None or use_api():
        note = ("Two images are attached: overlay.png (reference faint red, the person's ink black, regions boxed "
                "yellow) and reference.png (the reference alone).")
        return {"reply": ask_api(build_prompt(result, level, question, reference_name, note), images, api_client),
                "route": "api"}
    workdir = Path(tempfile.mkdtemp(prefix="drawing-room-coach-"))
    try:
        for name, data in images.items():
            (workdir / name).write_bytes(data)
        note = (f"Read {workdir / OVERLAY_FILE} (reference in faint red, the person's ink in black, regions boxed "
                f"in yellow) and {workdir / REFERENCE_FILE} (the reference alone) before answering.")
        return {"reply": ask_cli(build_prompt(result, level, question, reference_name, note), workdir, runner),
                "route": "claude-cli"}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
