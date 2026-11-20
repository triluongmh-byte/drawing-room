import json
import math

import pytest

from drawing_room import assist
from drawing_room.projects import ProjectStore
from drawing_room.references import BUILTINS, render
from drawing_room.server import App

from test_server import FakeRunner, call, running  # noqa: F401  (the fixture)


def test_line_is_sampled_every_few_units():
    points = assist.shape_points({"type": "line", "a": [0, 0], "b": [300, 0]})
    assert points[0] == (0, 0) and points[-1] == (300, 0)
    assert len(points) >= 100
    assert max(math.dist(a, b) for a, b in zip(points, points[1:])) <= assist.STEP + 1e-9


def test_circle_ellipse_and_arc_follow_their_curves():
    circle = assist.shape_points({"type": "circle", "c": [500, 375], "r": 100})
    assert all(abs(math.dist(p, (500, 375)) - 100) < 1e-6 for p in circle)
    assert math.dist(circle[0], circle[-1]) < 1e-6  # closed
    ellipse = assist.shape_points({"type": "ellipse", "c": [0, 0], "rx": 200, "ry": 50, "rotation": 90})
    xs, ys = [p[0] for p in ellipse], [p[1] for p in ellipse]
    assert max(ys) == pytest.approx(200, abs=0.5) and max(xs) == pytest.approx(50, abs=0.5)  # turned upright
    arc = assist.shape_points({"type": "arc", "c": [0, 0], "r": 100, "start": 0, "end": 90})
    assert arc[0] == pytest.approx((100, 0)) and arc[-1] == pytest.approx((0, 100))  # y down: clockwise


def test_rect_polyline_and_bezier():
    rect = assist.shape_points({"type": "rect", "x": 10, "y": 20, "w": 100, "h": 50})
    assert rect[0] == (10, 20) and rect[-1] == pytest.approx((10, 20))
    assert {round(p[0]) for p in rect} >= {10, 110}
    closed = assist.shape_points({"type": "polyline", "points": [[0, 0], [100, 0], [100, 100]], "closed": True})
    assert closed[-1] == pytest.approx((0, 0))
    curve = assist.shape_points({"type": "bezier", "points": [[0, 0], [0, 100], [100, 100], [100, 0]]})
    assert curve[0] == (0, 0) and curve[-1] == pytest.approx((100, 0))
    assert max(p[1] for p in curve) == pytest.approx(75, abs=1)


@pytest.mark.parametrize("shape", [
    {"type": "line", "a": [0, 0]},
    {"type": "circle", "c": [0, 0], "r": -5},
    {"type": "circle", "c": [0, 0], "r": float("nan")},
    {"type": "line", "a": [0, 0], "b": [1e9, 0]},
    {"type": "bezier", "points": [[0, 0], [1, 1]]},
    {"type": "spiral"},
    "not a shape",
])
def test_bad_shapes_are_skipped_not_fatal(shape):
    strokes, skipped = assist.shapes_to_strokes([shape, {"type": "line", "a": [0, 0], "b": [10, 0]}])
    assert len(strokes) == 1 and len(skipped) == 1


def test_styles_and_colours_are_checked():
    strokes, _ = assist.shapes_to_strokes([
        {"type": "line", "a": [0, 0], "b": [10, 0], "style": "construction"},
        {"type": "line", "a": [0, 0], "b": [10, 0], "style": "weird", "color": "red"},
        {"type": "line", "a": [0, 0], "b": [10, 0], "color": "#AA3300"},
    ])
    assert [(s["style"], s["color"]) for s in strokes] == [("construction", None), ("line", None), ("line", "#AA3300")]


def test_parse_answer_reads_json_fenced_or_bare_and_falls_back_to_text():
    bare = assist.parse_answer('{"reply": "Đây", "shapes": [{"type": "circle", "c": [1, 2], "r": 3}]}')
    assert bare["reply"] == "Đây" and len(bare["shapes"]) == 1 and bare["clear_previous"] is False
    fenced = assist.parse_answer('Sure!\n```json\n{"reply": "ok", "shapes": [], "clear_previous": true}\n```')
    assert fenced == {"reply": "ok", "shapes": [], "clear_previous": True}
    assert assist.parse_answer("just words") == {"reply": "just words", "shapes": [], "clear_previous": False}


def test_sheet_falls_back_to_the_frame():
    assert assist.parse_sheet(None) == (0, 0, 1000, 750)
    assert assist.parse_sheet([0, 0, 5, 5]) == (0, 0, 1000, 750)
    assert assist.parse_sheet([0, -332, 1000, 1082]) == (0, -332, 1000, 1082)


def test_drawing_image_covers_the_sheet():
    strokes = [{"points": [[100, 100, 0.5], [900, 600, 0.5]]}, {"points": [[0, 0], [10, 10]], "assistant": True}]
    image = assist.drawing_image(render(BUILTINS["circle"]), strokes, (0, -332, 1000, 1082))
    assert image.size == (round(1000 * 1200 / 1414), 1200)


class AnswerRunner(FakeRunner):
    def __init__(self, answer):
        super().__init__(json.dumps(answer, ensure_ascii=False))


def test_assist_route_draws_shapes_with_claude(running, tmp_path):
    runner = AnswerRunner({"reply": "Mình vẽ khung hộp cho bạn.",
                           "shapes": [{"type": "rect", "x": 300, "y": 200, "w": 400, "h": 300, "style": "construction"},
                                      {"type": "circle", "c": [500, 350], "r": 80}]})
    srv = running(app=App(coach_runner=runner, projects=ProjectStore(tmp_path)))
    status, body, _ = call(srv, "POST", "/api/assist", {
        "level": 2, "reference": {"id": "cube"}, "strokes": [], "sheet": [0, 0, 1000, 750],
        "message": "vẽ giúp tao cái hộp", "history": [{"role": "user", "text": "chào"}, {"role": "assistant", "text": "chào bạn"}]})
    assert status == 200
    assert body["reply"] == "Mình vẽ khung hộp cho bạn." and body["route"] == "claude-cli"
    assert [s["style"] for s in body["strokes"]] == ["construction", "line"]
    assert body["skipped"] == [] and body["clear_previous"] is False
    run = runner.calls[0]
    assert run["files"] == ["drawing.png", "reference.png"]
    assert "vẽ giúp tao cái hộp" in run["prompt"] and "Person: chào" in run["prompt"]
    arguments = run["arguments"]
    assert arguments[arguments.index("--allowedTools") + 1] == "Read"
    assert "CAD" in arguments[arguments.index("--append-system-prompt") + 1]


def test_assist_works_without_a_reference_and_needs_a_message(running, tmp_path):
    srv = running(app=App(coach_runner=AnswerRunner({"reply": "Hi", "shapes": []}), projects=ProjectStore(tmp_path)))
    status, body, _ = call(srv, "POST", "/api/assist", {"level": 2, "strokes": [], "message": "hello"})
    assert status == 200 and body["reply"] == "Hi" and body["strokes"] == []
    status, body, _ = call(srv, "POST", "/api/assist", {"level": 2, "strokes": [], "message": "  "})
    assert status == 502 and "say what" in body["error"]


def test_assist_uses_the_api_when_given_a_client():
    class Messages:
        def __init__(self):
            self.kwargs = None

        def create(self, **kwargs):
            self.kwargs = kwargs
            text = json.dumps({"reply": "ok", "shapes": [{"type": "line", "a": [0, 0], "b": [50, 0]}]})
            return type("R", (), {"stop_reason": "end_turn", "content": [type("B", (), {"type": "text", "text": text})()]})()

    client = type("C", (), {})()
    client.beta = type("Beta", (), {})()
    client.beta.messages = Messages()
    answer = assist.assist(None, None, [], None, 2, "draw a line", api_client=client)
    assert answer["route"] == "api" and len(answer["strokes"]) == 1
    sent = client.beta.messages.kwargs
    assert "CAD" in sent["system"]
    assert [c["text"] for c in sent["messages"][0]["content"] if c["type"] == "text"][0] == "Image: drawing.png"


def _data_url(image, fmt="PNG"):
    import base64
    import io
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return f"data:image/{fmt.lower()};base64," + base64.b64encode(buffer.getvalue()).decode()


def test_attached_pictures_go_to_claude_with_the_drawing(running, tmp_path):
    from PIL import Image
    runner = AnswerRunner({"reply": "Đẹp đó.", "shapes": []})
    srv = running(app=App(coach_runner=runner, projects=ProjectStore(tmp_path)))
    photo = _data_url(Image.new("RGB", (40, 30), "red"), "JPEG")
    status, body, _ = call(srv, "POST", "/api/assist", {
        "level": 2, "strokes": [], "message": "thầy coi hình này", "attachments": [photo, photo]})
    assert status == 200 and body["reply"] == "Đẹp đó."
    run = runner.calls[0]
    assert run["files"] == ["attachment-1.png", "attachment-2.png", "drawing.png"]
    assert "attached 2 pictures" in run["prompt"] and "attachment-2.png" in run["prompt"]
    assert "not the sheet" in run["prompt"]


def test_a_picture_alone_is_a_message():
    from PIL import Image
    answer = assist.assist(None, None, [], None, 2, "   ", runner=AnswerRunner({"reply": "Got it", "shapes": []}),
                           attachments=[assist.prepare_attachment(_data_url(Image.new("RGB", (8, 8))))])
    assert answer["reply"] == "Got it"


def test_attachments_are_checked_flattened_and_scaled_down():
    from PIL import Image
    import io
    big = assist.prepare_attachment(_data_url(Image.new("RGBA", (3200, 1600), (0, 0, 0, 0))))
    image = Image.open(io.BytesIO(big))
    assert image.size == (1600, 800) and image.mode == "RGB"
    assert image.getpixel((5, 5)) == (255, 255, 255)  # transparency becomes white paper
    for bad in [None, "hello", "data:text/plain;base64,aGk=", "data:image/png;base64,bm90IGFuIGltYWdl"]:
        with pytest.raises(ValueError):
            assist.prepare_attachment(bad)


def test_bad_or_too_many_attachments_are_refused(running, tmp_path):
    srv = running(app=App(coach_runner=AnswerRunner({"reply": "Hi", "shapes": []}), projects=ProjectStore(tmp_path)))
    status, body, _ = call(srv, "POST", "/api/assist", {"level": 2, "strokes": [], "message": "x",
                                                         "attachments": ["data:image/png;base64,AAAA"]})
    assert status == 400 and "attached picture" in body["error"]
    status, body, _ = call(srv, "POST", "/api/assist", {"level": 2, "strokes": [], "message": "x", "attachments": ["a"] * 5})
    assert status == 400 and "at most 4" in body["error"]


def test_attachments_are_not_logged():
    from drawing_room.server import redact
    assert redact({"message": "hi", "attachments": ["data:image/png;base64,AAAA", 3]})["attachments"] == [
        "<26 chars>", "<not a string>"]


def test_shapes_can_name_a_layer_and_fill_closed_shapes():
    strokes, skipped = assist.shapes_to_strokes([
        {"type": "polyline", "points": [[0, 0], [100, 0], [100, 100]], "closed": True, "fill": True,
         "layer": "  Tô   mặt ", "color": "#8b7fd6"},
        {"type": "line", "a": [0, 0], "b": [10, 0], "fill": True, "layer": "x" * 40},
        {"type": "circle", "c": [50, 50], "r": 5, "fill": True, "layer": ""},
        {"type": "polyline", "points": [[0, 0], [5, 5]], "fill": True},
    ])
    assert skipped == []
    assert strokes[0]["layer"] == "Tô mặt" and strokes[0]["fill"] is True and strokes[0]["color"] == "#8b7fd6"
    assert len(strokes[1]["layer"]) == assist.MAX_LAYER_NAME and "fill" not in strokes[1]  # a line has no area
    assert "layer" not in strokes[2] and strokes[2]["fill"] is True
    assert "fill" not in strokes[3]  # an open polyline has no area


def test_the_prompt_teaches_the_perspective_layers():
    for words in ['Layer "Sketch"', 'Layer "Color"', 'Layer "Line"', "ONE box", "clean box", "VISIBLE edges", "four short sentences",
                  "the back corner"]:
        assert words in assist.SYSTEM_PROMPT


def test_filled_areas_are_drawn_under_the_lines():
    image = assist.drawing_image(None, [
        {"fill": True, "assistant": True, "points": [[100, 100], [300, 100], [300, 300], [100, 300]]},
        {"points": [[100, 200], [300, 200]]}], (0, 0, 1000, 750))
    scale = image.width / 1000
    assert image.getpixel((round(200 * scale), round(150 * scale))) == (205, 222, 245)
    assert image.getpixel((round(200 * scale), round(200 * scale))) == (30, 30, 30)


def test_shapes_can_set_width_opacity_and_dash():
    strokes, _ = assist.shapes_to_strokes([
        {"type": "line", "a": [0, 0], "b": [50, 0], "width": 1, "opacity": 0.4, "dash": True},
        {"type": "line", "a": [0, 0], "b": [50, 0], "width": 99, "opacity": -3, "dash": "yes"},
        {"type": "line", "a": [0, 0], "b": [50, 0], "width": True, "opacity": float("nan")},
    ])
    assert (strokes[0]["width"], strokes[0]["opacity"], strokes[0]["dash"]) == (1.0, 0.4, True)
    assert (strokes[1]["width"], strokes[1]["opacity"]) == (8.0, 0.1) and "dash" not in strokes[1]
    assert "width" not in strokes[2] and "opacity" not in strokes[2]
