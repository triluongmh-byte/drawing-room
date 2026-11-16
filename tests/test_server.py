import base64
import http.client
import io
import json
import math
import threading
from types import SimpleNamespace

import pytest
from PIL import Image

from drawing_room import server as server_module
from drawing_room.references import BUILTINS, png_bytes, render
from drawing_room.server import App, PinGate, create_server


def circle(cx=500, cy=375, r=220):
    return [{"layer": "line", "points": [[cx + r * math.cos(t / 30), cy + r * math.sin(t / 30), 0.5, t]
                                         for t in range(0, 190)]}]


class FakeRunner:
    """Stands in for subprocess.run of the claude command line."""

    def __init__(self, reply="Nice circle. Keep the pen moving."):
        self.reply, self.calls = reply, []

    def __call__(self, arguments, input, cwd, **kwargs):
        self.calls.append({"arguments": arguments, "prompt": input, "files": sorted(p.name for p in cwd.iterdir())})
        lines = [json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": self.reply}]}}),
                 json.dumps({"type": "result", "is_error": False, "result": self.reply})]
        return SimpleNamespace(stdout="\n".join(lines), stderr="", returncode=0)


@pytest.fixture
def running():
    started = []

    def start(lan=False, app=None):
        srv = create_server(0, lan=lan, app=app or App(coach_runner=FakeRunner()))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        started.append(srv)
        return srv

    yield start
    for srv in started:
        srv.shutdown()
        srv.server_close()


def call(srv, method, path, body=None, headers=None, host=None):
    port = srv.server_address[1]
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    data = json.dumps(body).encode() if body is not None else None
    sent = {"Host": host or f"127.0.0.1:{port}", **({"Content-Type": "application/json"} if data else {}),
            **(headers or {})}
    connection.request(method, path, body=data, headers=sent)
    response = connection.getresponse()
    raw = response.read()
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = raw
    return response.status, payload, response


def test_score_builtin(running):
    srv = running()
    status, body, _ = call(srv, "POST", "/api/score", {"level": 1, "reference": {"id": "circle"}, "strokes": circle()})
    assert status == 200 and body["shape"] == 10


def test_score_uploaded_image(running):
    srv = running()
    data_url = "data:image/png;base64," + base64.b64encode(png_bytes(render(BUILTINS["circle"]))).decode()
    status, body, _ = call(srv, "POST", "/api/score", {"level": 2, "reference": {"image": data_url}, "strokes": circle()})
    assert status == 200 and body["shape"] == 10 and body["method"] == "line-art"


def test_rejects_other_hosts_and_origins(running):
    srv = running()
    port = srv.server_address[1]
    assert call(srv, "GET", "/api/references", host=f"evil.example:{port}")[0] == 403
    status, _, _ = call(srv, "POST", "/api/score", {"level": 1}, headers={"Origin": "http://evil.example"})
    assert status == 403
    status, _, _ = call(srv, "POST", "/api/score", {"level": 1, "reference": {"id": "line"}, "strokes": []},
                        headers={"Origin": f"http://127.0.0.1:{port}"})
    assert status == 200


def test_lan_mode_requires_pin(running):
    app = App(gate=PinGate("123456"), coach_runner=FakeRunner())
    srv = running(lan=True, app=app)
    port = srv.server_address[1]
    lan_host = f"192.168.1.20:{port}"
    assert call(srv, "GET", "/api/references", host=lan_host)[0] == 401
    assert call(srv, "POST", "/api/score", {"level": 1}, host=lan_host)[0] == 401
    status, body, _ = call(srv, "GET", "/api/session", host=lan_host)
    assert status == 200 and body["pin_required"] and not body["authorised"]
    # Any Host is fine in LAN mode, but a cross-site Origin is not.
    assert call(srv, "POST", "/api/pin", {"pin": "123456"}, host=lan_host,
                headers={"Origin": "http://evil.example"})[0] == 403
    assert call(srv, "POST", "/api/pin", {"pin": "000000"}, host=lan_host)[0] == 403
    status, _, response = call(srv, "POST", "/api/pin", {"pin": "123456"}, host=lan_host,
                               headers={"Origin": f"http://{lan_host}"})
    assert status == 200
    cookie = response.getheader("Set-Cookie")
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie
    token = cookie.split(";")[0]
    assert call(srv, "GET", "/api/references", host=lan_host, headers={"Cookie": token})[0] == 200
    assert call(srv, "GET", "/api/references", host=lan_host, headers={"Cookie": "drawing_room_session=forged"})[0] == 401
    # Static files stay reachable so the PIN page can load.
    assert call(srv, "GET", "/", host=lan_host)[0] == 200


def test_pin_lockout_after_repeated_failures():
    now = [0.0]
    gate = PinGate("654321", clock=lambda: now[0])
    for _ in range(server_module.MAX_PIN_FAILURES):
        with pytest.raises(PermissionError, match="wrong"):
            gate.login("111111")
    with pytest.raises(PermissionError, match="too many"):
        gate.login("654321")
    now[0] += server_module.PIN_LOCKOUT + 1
    assert gate.check(gate.login("654321"))


def test_body_size_capped(running, monkeypatch):
    monkeypatch.setattr(server_module, "MAX_BODY", 100)
    srv = running()
    status, _, _ = call(srv, "POST", "/api/score", {"level": 1, "reference": {"id": "line"}, "strokes": circle()})
    assert status == 413


def test_post_logging_on_success_and_error(running, monkeypatch):
    logged = []
    monkeypatch.setattr(server_module, "log_post", lambda *args: logged.append(args))
    srv = running()
    call(srv, "POST", "/api/score", {"level": 1, "reference": {"id": "circle"}, "strokes": circle()})
    call(srv, "POST", "/api/score", {"level": 9, "reference": {"id": "circle"}, "strokes": []})
    call(srv, "POST", "/api/score", {"level": 1, "reference": {"id": "nope"}, "strokes": []})
    assert [entry[0] for entry in logged] == ["/api/score"] * 3
    ok, bad_level, missing = logged
    assert ok[3] is None and ok[2]["shape"] == 10
    assert "level" in bad_level[3] and bad_level[2] == {"error": "level must be 0 to 4"}
    assert "no such reference" in missing[3]


def test_post_logging_reports_unexpected_errors(running, monkeypatch):
    logged = []
    monkeypatch.setattr(server_module, "log_post", lambda *args: logged.append(args))
    monkeypatch.setattr(server_module.scoring, "score", lambda *a: 1 / 0)
    srv = running()
    status, body, _ = call(srv, "POST", "/api/score", {"level": 1, "reference": {"id": "circle"}, "strokes": []})
    assert status == 500 and body == {"error": "server error"}
    assert "ZeroDivisionError" in logged[0][3]


def test_log_post_sends_redacted_gelf(monkeypatch):
    sent = []
    monkeypatch.setenv("DRAWING_ROOM_GRAYLOG", "graylog.local:12201")
    monkeypatch.setattr(server_module, "send_gelf", lambda address, payload: sent.append((address, payload)))
    server_module.log_post("/api/pin", {"pin": "123456"}, {"ok": True}, None)
    server_module.log_post("/api/coach", {"reference": {"image": "data:image/png;base64," + "A" * 5000},
                                          "strokes": circle()}, {"reply": "hi"}, "boom")
    assert sent[0][0] == "graylog.local:12201"
    assert "123456" not in sent[0][1]["request"]
    assert "AAAA" not in sent[1][1]["request"] and '"count": 1' in sent[1][1]["request"]
    assert sent[1][1]["error"] == "boom"


def test_send_gelf_format(monkeypatch):
    captured = {}

    class FakeSocket:
        def __init__(self, *a):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def sendto(self, data, address):
            captured["data"], captured["address"] = data, address

    monkeypatch.setattr(server_module.socket, "socket", FakeSocket)
    server_module.send_gelf("10.0.0.5:12201", {"path": "/api/score", "request": "{}", "response": "{}", "error": ""})
    message = json.loads(captured["data"])
    assert captured["address"] == ("10.0.0.5", 12201)
    assert message["version"] == "1.1" and message["short_message"] == "POST /api/score" and message["_path"] == "/api/score"


def test_coach_route_uses_claude_with_read_only(running):
    runner = FakeRunner("Close the gap at M1 first.")
    srv = running(app=App(coach_runner=runner))
    status, body, _ = call(srv, "POST", "/api/coach", {"level": 2, "reference": {"id": "circle"},
                                                       "strokes": circle(r=200), "question": "what is wrong?"})
    assert status == 200
    assert body["reply"] == "Close the gap at M1 first." and body["route"] == "claude-cli"
    assert "shape" in body["score"]
    run = runner.calls[0]
    assert run["files"] == ["overlay.png", "reference.png"]
    arguments = run["arguments"]
    assert arguments[arguments.index("--allowedTools") + 1] == "Read"
    assert "Bash" in arguments[arguments.index("--disallowedTools") + 1]
    assert "what is wrong?" in run["prompt"]


def test_coach_failure_is_reported(running):
    def broken(*args, **kwargs):
        raise FileNotFoundError

    srv = running(app=App(coach_runner=broken))
    status, body, _ = call(srv, "POST", "/api/coach", {"level": 2, "reference": {"id": "circle"}, "strokes": []})
    assert status == 502 and "claude" in body["error"]


def test_static_files_and_reference_images(running):
    srv = running()
    status, _, response = call(srv, "GET", "/static/vendor/perfect-freehand.js")
    assert status == 200 and response.getheader("Content-Type").startswith("text/javascript")
    status, body, response = call(srv, "GET", "/api/references/cube.png?guide=0")
    assert status == 200 and response.getheader("Content-Type") == "image/png"
    assert Image.open(io.BytesIO(body)).size == (1000, 750)
    assert call(srv, "GET", "/static/../server.py")[0] == 404
    status, body, _ = call(srv, "GET", "/api/references")
    assert {ref["id"] for ref in body["references"]} >= {"line", "circle", "ellipse", "cube", "cylinder", "apple"}
