"""Browser check for the paint bucket, the colour picker, picture export and project files.

Needs Google Chrome and a running server with an EMPTY, throwaway data directory (never your real projects, never
the server you draw on). Screenshots go to the folder given. Run:
    uv run drawing-room serve --port 8499 --data "$(mktemp -d)" &
    uv run --with playwright python scripts/e2e_files.py http://127.0.0.1:8499/ "$(mktemp -d)"
"""
import json
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

URL, OUT = sys.argv[1], Path(sys.argv[2])

DRAW = """
async ({points, alt}) => {
  const canvas = document.getElementById('paper');
  const rect = canvas.getBoundingClientRect();
  const at = ([x, y]) => { const [sx, sy] = window.drawingRoom.paperToScreen(x, y); return [rect.left + sx, rect.top + sy]; };
  const fire = (name, p) => {
    const [cx, cy] = at(p);
    canvas.dispatchEvent(new PointerEvent(name, {pointerId: 9, pointerType: 'pen', clientX: cx, clientY: cy, pressure: 0.6,
      bubbles: true, cancelable: true, button: 0, buttons: name === 'pointerup' ? 0 : 1, isPrimary: true, altKey: !!alt}));
  };
  fire('pointerdown', points[0]);
  for (let i = 1; i < points.length; i++) fire('pointermove', points[i]);
  fire('pointerup', points[points.length - 1]);
}
"""
STATE = "window.drawingRoom.state"
STROKES = f"() => {STATE}.history.doc.layers.flatMap(l => l.strokes.map(s => s.tool))"
failed = False


def check(ok, what):
    global failed
    print(("PASS " if ok else "FAIL ") + what)
    failed |= not ok


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1280, "height": 860}, accept_downloads=True)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function(f"{STATE}.project")
    page.wait_for_timeout(300)

    # A rectangle with the Shapes tool, then the bucket poured inside it.
    page.keyboard.press("u")
    page.evaluate(DRAW, {"points": [[300, 200], [500, 320], [700, 450]], "alt": False})
    page.keyboard.press("f")
    check(page.evaluate(f"{STATE}.tool") == "fill", "F picks the paint bucket")
    page.evaluate(f"() => {{ {STATE}.tools.fill.color = '#2e8b57'; }}")
    page.evaluate(DRAW, {"points": [[500, 320]], "alt": False})
    tools = page.evaluate(STROKES)
    check(tools == ["shape", "fill"], f"the bucket adds one fill inside the rectangle ({tools})")
    box = page.evaluate(f"() => {{ const s = {STATE}.history.doc.layers.flatMap(l => l.strokes).find(s => s.tool === 'fill');"
                        " const xs = s.points.map(p => p[0]), ys = s.points.map(p => p[1]);"
                        " return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }")
    check(295 <= box[0] <= 305 and 445 <= box[3] <= 455, f"the fill stays inside the rectangle's lines ({box})")
    page.evaluate(DRAW, {"points": [[900, 600]], "alt": False})
    check(len(page.evaluate(STROKES)) == 3, "outside every shape, the bucket fills the open paper (undo takes it back)")
    page.keyboard.press("Meta+z")
    check(len(page.evaluate(STROKES)) == 2, "undo removes a fill")
    page.screenshot(path=str(OUT / "bucket.png"))

    # The picker takes the fill's colour for the pencil, then hands back to the pencil.
    page.keyboard.press("p")
    page.keyboard.press("k")
    check(page.evaluate(f"{STATE}.tool") == "picker", "K picks the colour picker")
    page.evaluate(DRAW, {"points": [[400, 260]], "alt": False})
    check(page.evaluate(f"{STATE}.tool") == "pencil", "after one pick, back on the pencil")
    picked = page.evaluate(f"{STATE}.tools.pencil.color")
    check(picked == "#2e8b57", f"the pencil takes the fill's colour ({picked})")
    page.evaluate(f"() => {{ {STATE}.tools.pencil.color = '#141312'; }}")
    page.evaluate(DRAW, {"points": [[400, 260]], "alt": True})
    check(page.evaluate(f"{STATE}.tools.pencil.color") == "#2e8b57" and len(page.evaluate(STROKES)) == 2,
          "Alt-click picks with the pencil instead of drawing")

    # Ctrl+S saves now and the status says so.
    page.keyboard.press("Control+s")
    page.wait_for_function("document.getElementById('project-status').textContent === 'Saved ✓'")
    check(True, "Ctrl+S saves and the status shows Saved ✓")

    # Export PNG and JPG from the project menu.
    page.click("#project-button")
    for fmt in ("png", "jpg"):
        with page.expect_download() as info:
            page.click(f"#export-{fmt}")
        path = OUT / info.value.suggested_filename
        info.value.save_as(path)
        image = Image.open(path).convert("RGB")
        w, h = image.size
        inside = image.getpixel((int(w * 0.5), int(h * 0.5 * 0.86)))
        check(path.suffix == f".{fmt}" and w >= 2000, f"{fmt.upper()} export {path.name} is {w}x{h}")
        check(inside[1] > inside[0] + 40, f"the {fmt.upper()} shows the green fill ({inside})")
        check(image.getpixel((3, 3)) == (255, 255, 255) or fmt == "jpg", f"the {fmt.upper()} paper is white")

    # Save the project file, then open it back as a new project.
    with page.expect_download() as info:
        page.click("#file-save")
    saved = OUT / info.value.suggested_filename
    info.value.save_as(saved)
    data = json.loads(saved.read_text())
    check(saved.name.endswith(".drawing.json") and data["format"] == "drawing-room", f"saved {saved.name}")
    first = page.evaluate(f"{STATE}.project.id")
    page.set_input_files("#file-input", str(saved))
    page.wait_for_function(f"{STATE}.project.id !== '{first}'")
    page.wait_for_timeout(300)
    check(page.evaluate(STROKES) == ["shape", "fill"], "the opened file is a new project with the same drawing")
    bad = OUT / "not-a-drawing.json"
    bad.write_text('{"hello": 1}')
    page.click("#project-button")
    page.set_input_files("#file-input", str(bad))
    page.wait_for_timeout(400)
    check("not a Sketchbook Club file" in page.text_content("#paper-hint"), "a wrong file says so")
    page.keyboard.press("Escape")
    page.click("#project-button")
    page.screenshot(path=str(OUT / "project-menu.png"))

    check(not errors, f"no page errors {errors}")
    browser.close()

sys.exit(1 if failed else 0)
