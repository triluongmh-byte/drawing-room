import math

import numpy as np
from PIL import Image, ImageDraw

from drawing_room import scoring
from drawing_room.references import BUILTINS, PAPER_H, PAPER_W, letterbox, render

CX, CY = PAPER_W / 2, PAPER_H / 2


def ellipse_stroke(cx=CX, cy=CY, rx=220, ry=220, layer="line", n=200):
    points = [[cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n), 0.5, i * 8]
              for i in range(n + 1)]
    return {"layer": layer, "tool": "ink", "points": points}


def test_identical_circle_scores_ten():
    result = scoring.score(BUILTINS["circle"], [ellipse_stroke()], level=1)
    assert result["shape"] == 10
    assert result["proportion"] == 10
    assert result["misses"] == [] and result["strays"] == []


def test_identical_circle_from_uploaded_line_art_scores_ten():
    image = render(BUILTINS["circle"])
    result = scoring.score(image, [ellipse_stroke()], level=2)
    assert result["method"] == "line-art"
    assert result["shape"] == 10


def test_offset_circle_loses_shape_when_tracing():
    for level in (1, 2):
        exact = scoring.score(BUILTINS["circle"], [ellipse_stroke()], level)
        offset = scoring.score(BUILTINS["circle"], [ellipse_stroke(cx=CX + 40, cy=CY + 25)], level)
        assert offset["shape"] < exact["shape"] - 3
        assert offset["misses"] and offset["strays"]


def test_scaled_and_shifted_circle_is_not_penalised_from_memory():
    for level in (3, 4):
        result = scoring.score(BUILTINS["circle"], [ellipse_stroke(cx=300, cy=280, rx=120, ry=120)], level)
        assert result["aligned"] is True
        assert result["shape"] >= 9.5
        assert result["proportion"] >= 9.5


def test_misses_map_back_onto_the_drawing_when_aligned():
    # A half circle drawn small in the corner: the missing half should be marked next to the drawing, not the reference.
    n = 100
    half = [[300 + 100 * math.cos(math.pi * i / n), 250 + 100 * math.sin(math.pi * i / n), 0.5, i] for i in range(n + 1)]
    result = scoring.score(BUILTINS["circle"], [{"layer": "line", "points": half}], level=3)
    assert result["misses"]
    x0, y0, x1, y1 = result["misses"][0]["box"]
    assert 100 < x0 and x1 < 520 and y1 < 520


def test_squashed_circle_loses_proportion():
    for level in (1, 3):
        squashed = scoring.score(BUILTINS["circle"], [ellipse_stroke(rx=220, ry=140)], level)
        assert squashed["proportion"] <= 6
        assert squashed["proportion"] < scoring.score(BUILTINS["circle"], [ellipse_stroke()], level)["proportion"]


def test_empty_drawing_scores_zero():
    for level in range(5):
        result = scoring.score(BUILTINS["cube"], [], level)
        assert result["shape"] == 0 and result["proportion"] == 0 and result["overall"] == 0
        assert result["misses"]


def test_color_layer_is_not_scored():
    stroke = ellipse_stroke(layer="color")
    assert scoring.score(BUILTINS["circle"], [stroke], 1)["shape"] == 0


def test_the_layer_scored_flag_wins_over_the_layer_name():
    custom = {**ellipse_stroke(layer="l1abc"), "scored": True}
    assert scoring.score(BUILTINS["circle"], [custom], 1)["shape"] == 10
    muted = {**ellipse_stroke(layer="line"), "scored": False}
    assert scoring.score(BUILTINS["circle"], [muted], 1)["shape"] == 0
    assert scoring.stroke_stats([custom, muted])["stroke_count"] == 1


def test_line_art_extraction_handles_transparency_and_thick_lines():
    image = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
    ImageDraw.Draw(image).line([(50, 150), (350, 150)], fill=(0, 0, 0, 255), width=12)
    paper = letterbox(image)
    mask, method = scoring.extract_lines(paper)
    assert method == "line-art"
    ys, xs = np.nonzero(mask)
    assert abs(ys.mean() * 2 - PAPER_H / 2) < 4 and xs.min() * 2 < 200 and xs.max() * 2 > 800
    # A single thin pencil line through the middle of the thick stroke covers it.
    result = scoring.score(paper, [{"layer": "sketch", "points": [[130, 375], [870, 375]]}], level=2)
    assert result["shape"] >= 9


def test_photo_uses_edge_detection():
    yy, xx = np.mgrid[0:PAPER_H, 0:PAPER_W]
    photo = (80 + 60 * np.sin(xx / 40.0) + 40 * (yy / PAPER_H)).astype(np.uint8)
    photo[(xx - CX) ** 2 + (yy - CY) ** 2 < 200 ** 2] = 230
    mask, method = scoring.extract_lines(Image.fromarray(photo).convert("RGB"))
    assert method == "edges"
    assert mask.any()


def test_stroke_stats_flag_scratchy_strokes():
    short = [{"layer": "sketch", "points": [[100 + i * 30, 100, 0.5, 0], [110 + i * 30, 105, 0.5, 40]]} for i in range(6)]
    stats = scoring.stroke_stats(short + [ellipse_stroke()])
    assert stats["stroke_count"] == 7
    assert stats["short_share"] == round(6 / 7, 2)
    assert stats["mean_length"] > 0


def test_next_step_walks_through_builtin_steps():
    cube = BUILTINS["cube"]
    first = scoring.score(cube, [], level=1)["next_step"]
    assert first["index"] == 0 and first["box"]
    front = [{"layer": "line", "points": [list(p) for p in cube.steps[0].lines[0]]}]
    assert scoring.score(cube, front, level=1)["next_step"]["index"] == 1


def test_every_builtin_scores_ten_against_itself():
    for ref in BUILTINS.values():
        strokes = [{"layer": "line", "points": [list(p) for p in line]} for step in ref.steps for line in step.lines]
        assert scoring.score(ref, strokes, 1)["shape"] == 10, ref.id
