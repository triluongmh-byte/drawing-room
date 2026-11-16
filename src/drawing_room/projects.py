"""Projects: named drawings kept on the server, so the iPad and the Mac open the same work.

Each project is two JSON files in the data directory: ``<id>.meta.json`` (name, times, stroke count; cheap to list)
and ``<id>.json`` (the drawing: level, reference, layers, ruler...). Ids are made here and checked against a strict
pattern before they ever touch a path. Writes go to a temp file first and are swapped in, so a crash never leaves
half a file. Two devices saving the same project at once: the last save wins.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path

ID_PATTERN = re.compile(r"[0-9a-f]{12}")
MAX_NAME = 60
MAX_PROJECTS = 500
DEFAULT_DATA = Path.home() / ".drawing-room" / "projects"


class ProjectError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def clean_name(name, fallback: str = "Untitled") -> str:
    text = " ".join(str(name or "").split())[:MAX_NAME]
    return text or fallback


def stroke_count(drawing: dict) -> int:
    layers = drawing.get("layers") if isinstance(drawing, dict) else None
    if not isinstance(layers, list):
        return 0
    return sum(len(layer.get("strokes", [])) for layer in layers
               if isinstance(layer, dict) and isinstance(layer.get("strokes"), list))


def check_drawing(drawing) -> dict:
    """A drawing is a JSON object; if it has layers they are a list of objects."""
    if drawing is None:
        return {}
    if not isinstance(drawing, dict):
        raise ProjectError(400, "drawing must be an object")
    layers = drawing.get("layers")
    if layers is not None and (not isinstance(layers, list) or not all(isinstance(layer, dict) for layer in layers)):
        raise ProjectError(400, "drawing.layers must be a list of layers")
    return drawing


class ProjectStore:
    def __init__(self, root: Path | str = DEFAULT_DATA, clock=time.time):
        self.root = Path(root)
        self.clock = clock
        self._lock = threading.Lock()

    # ------------------------------------------------------------ files

    def _path(self, project_id: str, suffix: str) -> Path:
        if not isinstance(project_id, str) or not ID_PATTERN.fullmatch(project_id):
            raise ProjectError(404, "no such project")
        return self.root / f"{project_id}{suffix}"

    def _write(self, path: Path, value) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=self.root, prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as file:
                json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
            os.replace(temp, path)
        except BaseException:
            Path(temp).unlink(missing_ok=True)
            raise

    def _read(self, path: Path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ProjectError(404, "no such project") from None

    def _meta(self, project_id: str) -> dict:
        return self._read(self._path(project_id, ".meta.json"))

    # ------------------------------------------------------------ operations

    def list(self) -> list[dict]:
        """Every project's metadata, most recently changed first."""
        if not self.root.is_dir():
            return []
        found = []
        for path in self.root.glob("*.meta.json"):
            if not ID_PATTERN.fullmatch(path.name.removesuffix(".meta.json")):
                continue
            try:
                found.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return sorted(found, key=lambda meta: meta.get("updated", 0), reverse=True)

    def create(self, name=None, drawing=None) -> dict:
        drawing = check_drawing(drawing)
        with self._lock:
            if len(self.list()) >= MAX_PROJECTS:
                raise ProjectError(409, f"you can keep up to {MAX_PROJECTS} projects")
            project_id = secrets.token_hex(6)
            now = self.clock()
            meta = {"id": project_id, "name": clean_name(name), "created": now, "updated": now,
                    "strokes": stroke_count(drawing)}
            self._write(self._path(project_id, ".json"), drawing)
            self._write(self._path(project_id, ".meta.json"), meta)
            return meta

    def get(self, project_id: str) -> dict:
        meta = self._meta(project_id)
        return {"project": meta, "drawing": self._read(self._path(project_id, ".json"))}

    def save(self, project_id: str, drawing) -> dict:
        """Replace the drawing. A drawing without a ``reference`` key keeps the saved one, so a large uploaded
        image is only sent when it changes."""
        drawing = check_drawing(drawing)
        with self._lock:
            meta = self._meta(project_id)
            if "reference" not in drawing:
                previous = self._read(self._path(project_id, ".json"))
                if isinstance(previous, dict) and "reference" in previous:
                    drawing = {**drawing, "reference": previous["reference"]}
            meta.update(updated=self.clock(), strokes=stroke_count(drawing))
            self._write(self._path(project_id, ".json"), drawing)
            self._write(self._path(project_id, ".meta.json"), meta)
            return meta

    def rename(self, project_id: str, name) -> dict:
        with self._lock:
            meta = self._meta(project_id)
            meta.update(name=clean_name(name, meta["name"]), updated=self.clock())
            self._write(self._path(project_id, ".meta.json"), meta)
            return meta

    def delete(self, project_id: str) -> None:
        with self._lock:
            meta_path = self._path(project_id, ".meta.json")
            if not meta_path.exists():
                raise ProjectError(404, "no such project")
            meta_path.unlink()
            self._path(project_id, ".json").unlink(missing_ok=True)
