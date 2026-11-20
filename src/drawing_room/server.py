"""The local web server: static pages plus a small JSON API for references, scoring and coaching.

By default it binds to localhost only and refuses requests from other sites (Host and Origin checks), because the
coach runs the local ``claude`` command. With ``--lan`` it listens on every interface so an iPad on the same Wi-Fi can
use it, but only answers devices on the local network (private addresses, or the same /16 as this machine).
``--pin`` adds a 6-digit PIN printed at start-up, remembered in a cookie, for networks you share with others.
"""

from __future__ import annotations

import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from drawing_room import assist as assist_module
from drawing_room import coach as coach_module
from drawing_room import scoring
from drawing_room.projects import DEFAULT_DATA, ProjectError, ProjectStore
from drawing_room.references import BUILTINS, decode_data_url, png_bytes, render

logger = logging.getLogger("drawing_room.web")
STATIC = Path(__file__).parent / "static"
DEFAULT_PORT = 8430
MAX_BODY = 16 * 1024 * 1024
MAX_STROKES = 3000
MAX_POINTS = 300_000
COOKIE = "drawing_room_session"
MAX_PIN_FAILURES = 5
PIN_LOCKOUT = 60.0
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
                ".LICENSE": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json"}
OPEN_API = {"/api/session", "/api/pin"}


# ---------------------------------------------------------------- logging

def send_gelf(address: str, payload: dict) -> None:
    """Send one GELF message over UDP to ``host:port``."""
    host, _, port = address.rpartition(":")
    message = {"version": "1.1", "host": socket.gethostname(), "short_message": f"POST {payload['path']}",
               **{f"_{key}": value for key, value in payload.items()}}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.sendto(json.dumps(message).encode()[:8000], (host, int(port)))


def redact(request):
    """A copy of a request that is safe and small enough to log: no PIN, no image data, strokes summarised."""
    if not isinstance(request, dict):
        return request
    clean = dict(request)
    if "pin" in clean:
        clean["pin"] = "***"
    reference = clean.get("reference")
    if isinstance(reference, dict) and isinstance(reference.get("image"), str):
        clean["reference"] = {**reference, "image": f"<{len(reference['image'])} chars>"}
    strokes = clean.get("strokes")
    if isinstance(strokes, list):
        clean["strokes"] = summarise_strokes(strokes)
    attachments = clean.get("attachments")
    if isinstance(attachments, list):
        clean["attachments"] = [f"<{len(a)} chars>" if isinstance(a, str) else "<not a string>" for a in attachments]
    drawing = clean.get("drawing")
    if isinstance(drawing, dict):
        # A project save: keep the shape of the drawing, not its strokes or image data.
        layers = drawing.get("layers") if isinstance(drawing.get("layers"), list) else []
        every = [s for layer in layers if isinstance(layer, dict) and isinstance(layer.get("strokes"), list)
                 for s in layer["strokes"]]
        clean["drawing"] = {**{k: v for k, v in drawing.items() if k not in ("layers", "reference")},
                            "layers": len(layers), "strokes": summarise_strokes(every),
                            "reference": redact({"reference": drawing.get("reference")})["reference"]}
    return clean


def summarise_strokes(strokes: list) -> dict:
    return {"count": len(strokes), "points": sum(len(s.get("points", [])) for s in strokes if isinstance(s, dict))}


def log_post(path: str, request, response, error) -> None:
    """Record a POST for debugging. Goes to Graylog when ``DRAWING_ROOM_GRAYLOG=host:port`` is set."""
    payload = {"path": path, "request": json.dumps(redact(request), ensure_ascii=False, default=str)[:4000],
               "response": json.dumps(response, ensure_ascii=False, default=str)[:4000], "error": error or ""}
    logger.info("POST %s request=%s response=%s error=%s", path, payload["request"], payload["response"], payload["error"])
    address = os.environ.get("DRAWING_ROOM_GRAYLOG")
    if address:
        try:
            send_gelf(address, payload)
        except (OSError, ValueError) as failure:
            logger.warning("could not reach Graylog: %s", failure)


# ---------------------------------------------------------------- who may connect

def local_network_client(client: str, own_addresses: list[str]) -> bool:
    """Whether a LAN-mode client looks like a device on this network: loopback, a private or link-local address,
    or the same /16 as one of this machine's own addresses (some home networks use public-looking ranges)."""
    try:
        address = ipaddress.ip_address(client.split("%")[0])
    except ValueError:
        return False
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    if address.is_loopback or address.is_private or address.is_link_local:
        return True
    for own in own_addresses:
        try:
            if address in ipaddress.ip_network(f"{own}/16", strict=False):
                return True
        except ValueError:
            continue
    return False


# ---------------------------------------------------------------- PIN

class PinGate:
    """A 6-digit PIN for LAN mode. A right PIN earns a session cookie; wrong guesses are rate limited."""

    def __init__(self, pin: str | None = None, clock=time.monotonic):
        self.pin = pin or f"{secrets.randbelow(1_000_000):06d}"
        self._sessions: set[str] = set()
        self._failures = 0
        self._locked_until = 0.0
        self._clock = clock
        self._lock = threading.Lock()

    def check(self, token: str | None) -> bool:
        with self._lock:
            return bool(token) and any(hmac.compare_digest(token, known) for known in self._sessions)

    def login(self, pin: str) -> str:
        """A new session token for the right PIN. Raises PermissionError otherwise."""
        with self._lock:
            now = self._clock()
            if now < self._locked_until:
                raise PermissionError(f"too many wrong PINs; wait {int(self._locked_until - now) + 1} s")
            if not hmac.compare_digest(str(pin).strip().encode(), self.pin.encode()):
                self._failures += 1
                if self._failures >= MAX_PIN_FAILURES:
                    self._failures, self._locked_until = 0, now + PIN_LOCKOUT
                raise PermissionError("wrong PIN")
            self._failures = 0
            token = secrets.token_urlsafe(24)
            self._sessions.add(token)
            return token


class ApiError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- request parsing

def parse_level(request: dict) -> int:
    level = request.get("level", 1)
    if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= 4:
        raise ApiError(400, "level must be 0 to 4")
    return level


def parse_strokes(request: dict) -> list[dict]:
    strokes = request.get("strokes", [])
    if not isinstance(strokes, list) or len(strokes) > MAX_STROKES:
        raise ApiError(400, f"strokes must be a list of at most {MAX_STROKES}")
    total = 0
    for stroke in strokes:
        if not isinstance(stroke, dict) or not isinstance(stroke.get("points", []), list):
            raise ApiError(400, "each stroke needs a points list")
        total += len(stroke.get("points", []))
        for point in stroke.get("points", []):
            if not isinstance(point, list) or len(point) < 2 or not all(isinstance(v, (int, float)) for v in point[:6]):
                raise ApiError(400, "each point is [x, y, pressure, time, tiltX, tiltY]")
    if total > MAX_POINTS:
        raise ApiError(413, "too many points")
    return strokes


def parse_reference(request: dict):
    """The reference as (scoring input, image, display name)."""
    reference = request.get("reference")
    if not isinstance(reference, dict):
        raise ApiError(400, "send a reference: {id} for a built-in one or {image} for an upload")
    if reference.get("id"):
        builtin = BUILTINS.get(str(reference["id"]))
        if builtin is None:
            raise ApiError(404, "no such reference")
        return builtin, render(builtin), builtin.name
    try:
        image = decode_data_url(reference.get("image"))
    except (ValueError, OSError) as bad:
        raise ApiError(400, f"could not read the reference image: {bad}") from None
    name = str(reference.get("name") or "uploaded image")[:80]
    return image, image, name


# ---------------------------------------------------------------- handlers

class App:
    """What the handler needs; tests swap the coach runner."""

    def __init__(self, gate: PinGate | None = None, coach_runner=None, coach_api_client=None,
                 projects: ProjectStore | None = None):
        self.gate = gate
        self.projects = projects or ProjectStore(DEFAULT_DATA)
        self.coach_runner = coach_runner
        self.coach_api_client = coach_api_client

    def score(self, request: dict) -> dict:
        level = parse_level(request)
        strokes = parse_strokes(request)
        reference, _, _ = parse_reference(request)
        return scoring.score(reference, strokes, level)

    def coach(self, request: dict) -> dict:
        level = parse_level(request)
        strokes = parse_strokes(request)
        reference, image, name = parse_reference(request)
        result = scoring.score(reference, strokes, level)
        question = str(request.get("question") or "")[: coach_module.MAX_QUESTION]
        kwargs = {}
        if self.coach_runner is not None:
            kwargs["runner"] = self.coach_runner
        if self.coach_api_client is not None:
            kwargs["api_client"] = self.coach_api_client
        try:
            answer = coach_module.coach(image, name, strokes, result, level, question, **kwargs)
        except coach_module.CoachError as failure:
            raise ApiError(502, str(failure)) from None
        return {**answer, "score": result}

    def assist(self, request: dict) -> dict:
        """The chat: Claude draws shapes for an idea, or answers a question."""
        level = parse_level(request)
        strokes = parse_strokes(request)
        image = name = None
        if request.get("reference") is not None:
            _, image, name = parse_reference(request)
        raw = request.get("attachments") or []
        if not isinstance(raw, list) or len(raw) > assist_module.MAX_ATTACHMENTS:
            raise ApiError(400, f"attach at most {assist_module.MAX_ATTACHMENTS} pictures to a message")
        try:
            attachments = [assist_module.prepare_attachment(value) for value in raw]
        except ValueError as bad:
            raise ApiError(400, f"could not read an attached picture: {bad}") from None
        kwargs = {"attachments": attachments} if attachments else {}
        try:
            notes = assist_module.parse_notes(request.get("notes"))
        except ValueError as bad:
            raise ApiError(400, f"bad note: {bad}") from None
        if notes:
            kwargs["notes"] = notes
        if self.coach_runner is not None:
            kwargs["runner"] = self.coach_runner
        if self.coach_api_client is not None:
            kwargs["api_client"] = self.coach_api_client
        try:
            return assist_module.assist(image, name, strokes, request.get("sheet"), level,
                                        str(request.get("message") or ""), request.get("history"), **kwargs)
        except assist_module.AssistError as failure:
            raise ApiError(502, str(failure)) from None


PROJECT_ROUTE = re.compile(r"/api/projects/([0-9a-f]{12})(?:/(save|rename|delete))?")


def make_handler(app: App, allowed_hosts: set[str] | None, own_addresses: list[str] | None = None):
    """``allowed_hosts`` None means any Host (LAN mode); Origin must still match Host. In LAN mode
    ``own_addresses`` (this machine's addresses) decide which clients count as local."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "drawing-room"

        def log_message(self, *args):  # POSTs are logged by log_post
            pass

        def _send(self, code: int, body: bytes, content_type: str, headers: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, value, headers: dict | None = None) -> None:
            self._send(code, json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8", headers)

        def _trusted(self) -> bool:
            if own_addresses is not None and not local_network_client(self.client_address[0], own_addresses):
                return False
            host = self.headers.get("Host", "")
            if allowed_hosts is not None and host not in allowed_hosts:
                return False
            origin = self.headers.get("Origin")
            return origin is None or urlsplit(origin).netloc == host

        def _token(self) -> str | None:
            for part in self.headers.get("Cookie", "").split(";"):
                name, _, value = part.strip().partition("=")
                if name == COOKIE:
                    return value
            return None

        def _authorised(self, path: str) -> bool:
            return app.gate is None or path in OPEN_API or not path.startswith("/api/") or app.gate.check(self._token())

        def do_GET(self):
            if not self._trusted():
                return self._json(403, {"error": "forbidden"})
            url = urlsplit(self.path)
            path = url.path
            if not self._authorised(path):
                return self._json(401, {"error": "enter the PIN"})
            if path == "/":
                return self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path == "/api/session":
                return self._json(200, {"pin_required": app.gate is not None,
                                        "authorised": app.gate is None or app.gate.check(self._token()),
                                        "paper": [scoring.PAPER_W, scoring.PAPER_H]})
            if path == "/api/references":
                return self._json(200, {"references": [ref.meta() for ref in BUILTINS.values()]})
            if path == "/api/projects":
                return self._json(200, {"projects": app.projects.list()})
            found = PROJECT_ROUTE.fullmatch(path)
            if found and not found.group(2):
                try:
                    return self._json(200, app.projects.get(found.group(1)))
                except ProjectError as problem:
                    return self._json(problem.code, {"error": str(problem)})
            found = re.fullmatch(r"/api/references/([a-z]+)\.png", path)
            if found:
                ref = BUILTINS.get(found.group(1))
                if ref is None:
                    return self._json(404, {"error": "not found"})
                guide = parse_qs(url.query).get("guide", ["0"])[0] == "1"
                return self._send(200, png_bytes(render(ref, guide=guide)), "image/png")
            found = re.fullmatch(r"/static/([A-Za-z0-9_\-/]+\.[A-Za-z]+)", path)
            if found and ".." not in found.group(1):
                target = (STATIC / found.group(1)).resolve()
                suffix = ".LICENSE" if target.suffix == ".LICENSE" else target.suffix
                if target.is_relative_to(STATIC.resolve()) and target.is_file() and suffix in STATIC_TYPES:
                    return self._send(200, target.read_bytes(), STATIC_TYPES[suffix])
            return self._json(404, {"error": "not found"})

        def _route_post(self, request: dict) -> tuple[int, dict, dict]:
            if self.path == "/api/pin":
                if app.gate is None:
                    return 200, {"ok": True}, {}
                try:
                    token = app.gate.login(str(request.get("pin", "")))
                except PermissionError as wrong:
                    return 403, {"error": str(wrong)}, {}
                cookie = f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000"
                return 200, {"ok": True}, {"Set-Cookie": cookie}
            if self.path == "/api/score":
                return 200, app.score(request), {}
            if self.path == "/api/coach":
                return 200, app.coach(request), {}
            if self.path == "/api/assist":
                return 200, app.assist(request), {}
            if self.path == "/api/projects":
                return 200, {"project": app.projects.create(request.get("name"), request.get("drawing"))}, {}
            found = PROJECT_ROUTE.fullmatch(self.path)
            if found and found.group(2) == "save":
                return 200, {"project": app.projects.save(found.group(1), request.get("drawing"))}, {}
            if found and found.group(2) == "rename":
                return 200, {"project": app.projects.rename(found.group(1), request.get("name"))}, {}
            if found and found.group(2) == "delete":
                app.projects.delete(found.group(1))
                return 200, {"ok": True}, {}
            return 404, {"error": "not found"}, {}

        def do_POST(self):
            request, response, error, code, headers = None, None, None, 500, {}
            try:
                if not self._trusted():
                    code, response = 403, {"error": "forbidden"}
                    return
                if not self._authorised(urlsplit(self.path).path):
                    code, response = 401, {"error": "enter the PIN"}
                    return
                if self.headers.get_content_type() != "application/json":
                    code, response = 415, {"error": "send JSON"}
                    return
                length = int(self.headers.get("Content-Length") or 0)
                if length > MAX_BODY:
                    code, response = 413, {"error": "too large"}
                    self.close_connection = True
                    return
                request = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(request, dict):
                    raise ValueError("the body must be a JSON object")
                code, response, headers = self._route_post(request)
            except (ApiError, ProjectError) as problem:
                error, code, response = str(problem), problem.code, {"error": str(problem)}
            except ValueError as bad:
                error, code, response = str(bad), 400, {"error": "invalid request"}
            except Exception as failure:  # noqa: BLE001 - reported to the client and the log
                error, response = f"{type(failure).__name__}: {failure}", {"error": "server error"}
                logger.exception("POST failed")
            finally:
                log_post(self.path, request, response, error)
                self._json(code, response, headers)

    return Handler


def lan_addresses() -> list[str]:
    """Best-effort IPv4 addresses other devices can reach this machine on."""
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))  # no packet is sent; this only picks the outgoing interface
            found.append(probe.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            if info[4][0] not in found and not info[4][0].startswith("127."):
                found.append(info[4][0])
    except OSError:
        pass
    return found


def create_server(port: int = DEFAULT_PORT, lan: bool = False, app: App | None = None, pin: bool = False,
                  data: Path | str | None = None) -> ThreadingHTTPServer:
    """Pass port 0 to take any free port. ``pin`` gives the app a PIN gate if it has none."""
    app = app or App(projects=ProjectStore(data or DEFAULT_DATA))
    if pin and app.gate is None:
        app.gate = PinGate()
    server = ThreadingHTTPServer(("0.0.0.0" if lan else "127.0.0.1", port), None)
    actual = server.server_address[1]
    hosts = None if lan else {f"127.0.0.1:{actual}", f"localhost:{actual}"}
    server.RequestHandlerClass = make_handler(app, hosts, lan_addresses() if lan else None)
    server.app = app
    return server


def serve(port: int = DEFAULT_PORT, lan: bool = False, pin: bool = False, data: Path | str | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    server = create_server(port, lan, pin=pin, data=data)
    actual = server.server_address[1]
    print(f"drawing-room: http://127.0.0.1:{actual}", flush=True)
    if lan:
        for address in lan_addresses():
            print(f"  on your Wi-Fi: http://{address}:{actual}", flush=True)
    if server.app.gate:
        print(f"  PIN: {server.app.gate.pin}", flush=True)
    print(f"  projects: {server.app.projects.root}", flush=True)
    route = "Messages API" if coach_module.use_api() else "claude command line"
    print(f"  coach: {route}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
