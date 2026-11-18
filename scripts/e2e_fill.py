"""Browser check for the paint bucket: fill a closed shape, keep its lines on top, close small gaps, undo, erase,
save and export.

Needs a running server with an EMPTY data directory (never your real one). Run:
    uv run drawing-room serve --port 8431 --data "$(mktemp -d)" &
    uv run --with playwright --with pillow python scripts/e2e_fill.py http://127.0.0.1:8431/ docs/screenshots
"""
import io
import math
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

URL, OUT = sys.argv[1], sys.argv[2]

DRAW = """
async ({points}) => {
  const canvas = document.getElementById('paper');
  const rect = canvas.getBoundingClientRect();
  const at = ([x, y]) => { const [sx, sy] = window.drawingRoom.paperToScreen(x, y); return [rect.left + sx, rect.top + sy]; };
  const fire = (name, p) => {
    const [cx, cy] = at(p);
    canvas.dispatchEvent(new PointerEvent(name, {pointerId: 9, pointerType: 'pen', clientX: cx, clientY: cy, pressure: 0.6,
      bubbles: true, cancelable: true, button: 0, buttons: name === 'pointerup' ? 0 : 1, isPrimary: true}));
  };
  fire('pointerdown', points[0]);
  for (let i = 1; i < points.length; i++) fire('pointermove', points[i]);
  fire('pointerup', points[points.length - 1]);
}
"""
PIXEL = """([x, y]) => { const c = document.getElementById('paper'); const r = c.getBoundingClientRect();
  const [sx, sy] = window.drawingRoom.paperToScreen(x, y); const k = c.width / r.width;
  return [...c.getContext('2d').getImageData(Math.round(sx * k), Math.round(sy * k), 1, 1).data].slice(0, 3); }"""
FILLS = "() => window.drawingRoom.state.history.doc.layers.flatMap(l => l.strokes).filter(s => s.tool === 'fill').length"
failed = False


def check(cond, msg):
    global failed
    print(("PASS " if cond else "FAIL ") + msg)
    failed |= not cond


def circle(cx, cy, r, start=0.0, end=2 * math.pi + 0.3, n=120):
    return [[cx + r * math.cos(start + (end - start) * i / n), cy + r * math.sin(start + (end - start) * i / n)] for i in range(n + 1)]


def tap(page, x, y):
    page.evaluate(DRAW, {"points": [[x, y]]})
    page.wait_for_timeout(150)


def reddish(rgb):
    return rgb[0] > 180 and rgb[1] < 120 and rgb[2] < 110


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1180, "height": 820})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("() => window.drawingRoom.state.project", timeout=10000)
    page.select_option("#level", "2")
    page.wait_for_timeout(300)
    # Hide the reference so the pixels read are the drawing's own.
    page.evaluate("() => { window.drawingRoom.state.underlayState.visible = false; window.drawingRoom.state.dirty = true; }")

    # Ink a closed circle and an almost closed one (a small gap) on the Line layer.
    page.click("[data-tool=ink]")
    page.evaluate("() => { const s = window.drawingRoom.state; s.activeLayer = 'line'; }")
    page.evaluate(DRAW, {"points": circle(300, 380, 120)})
    page.evaluate(DRAW, {"points": circle(700, 380, 120, 0.06, 2 * math.pi - 0.06)})  # about a 15-unit gap at the right
    page.wait_for_timeout(200)

    # Pour red into the first circle.
    page.click("[data-tool=fill]")
    page.evaluate("""() => { const c = document.getElementById('color'); c.value = '#e0403a';
      c.dispatchEvent(new Event('input', {bubbles: true})); c.dispatchEvent(new Event('change', {bubbles: true})); }""")
    tap(page, 300, 380)
    check(page.evaluate(FILLS) == 1, "a tap inside the circle adds one fill")
    check(reddish(page.evaluate(PIXEL, [300, 380])), f"inside is red: {page.evaluate(PIXEL, [300, 380])}")
    check(reddish(page.evaluate(PIXEL, [300, 270])), "the fill reaches the edge of the circle")
    check(page.evaluate(PIXEL, [300, 560]) == [255, 255, 255], "outside stays white")
    line = page.evaluate(PIXEL, [420, 380])
    check(max(line) < 90, f"the ink line stays on top of the fill: {line}")
    check(page.evaluate("() => window.drawingRoom.state.history.doc.layers.find(l => l.id === 'line').strokes.findIndex(s => s.tool === 'fill')") == 2,
          "the fill is stored on the active layer")

    # A tap on the line itself does nothing.
    tap(page, 420, 380)
    check(page.evaluate(FILLS) == 1, "a tap on a line fills nothing")

    # With no gap closing the open circle leaks to the whole sheet; with the default size it holds.
    page.evaluate("() => { window.drawingRoom.state.tools.fill.size = 0; }")
    tap(page, 700, 380)
    check(page.evaluate(PIXEL, [960, 720]) != [255, 255, 255], "with size 0 paint leaks through the gap")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(150)
    check(page.evaluate(PIXEL, [960, 720]) == [255, 255, 255], "undo takes the leak back")
    page.evaluate("() => { window.drawingRoom.state.tools.fill.size = 10; }")
    tap(page, 700, 380)
    check(reddish(page.evaluate(PIXEL, [700, 380])) and page.evaluate(PIXEL, [960, 720]) == [255, 255, 255],
          "a bigger size closes the gap: inside filled, outside white")
    page.screenshot(path=f"{OUT}/16-fill.png")

    # Fills never count for the score.
    sent = page.evaluate("() => window.drawingRoom.state.history.doc.layers.flatMap(l => l.strokes).length")
    check(sent == 4, f"two lines and two fills: {sent}")

    # The eraser takes a fill away when it touches it.
    page.click("[data-tool=eraser]")
    tap(page, 300, 380)
    check(page.evaluate(FILLS) == 1 and page.evaluate(PIXEL, [300, 380]) == [255, 255, 255], "the eraser removes a fill")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(150)
    check(page.evaluate(FILLS) == 2, "undo brings it back")

    # Saved with the project and drawn again after a reload.
    page.evaluate("() => window.drawingRoom.flush()")
    page.reload()
    page.wait_for_function("() => window.drawingRoom.state.project", timeout=10000)
    page.wait_for_timeout(300)
    page.evaluate("() => { window.drawingRoom.state.underlayState.visible = false; window.drawingRoom.state.dirty = true; }")
    page.wait_for_timeout(150)
    check(page.evaluate(FILLS) == 2 and reddish(page.evaluate(PIXEL, [300, 380])), "fills survive a reload")

    # And in the exported image.
    page.click("#project-button")
    with page.expect_download() as info:
        page.click("#export-png")
    image = Image.open(io.BytesIO(open(info.value.path(), "rb").read())).convert("RGB")
    check(reddish(image.getpixel((2 * 300, 2 * 380))) and image.getpixel((2 * 300, 2 * 560)) == (255, 255, 255),
          "the PNG has the fill")

    page.keyboard.press("Escape")

    # Shapes: drag out a rectangle, a Shift-square, a triangle, an ellipse and a 15°-snapped line, then fill one.
    SHAPES = "() => window.drawingRoom.state.history.doc.layers.flatMap(l => l.strokes).filter(s => s.tool === 'shape')"
    page.click("[data-tool=eraser]")  # clear the circles out of the way: wipe the Line layer
    page.evaluate("() => { const s = window.drawingRoom.state; s.history.clear(); s.dirty = true; }")
    page.click("[data-tool=shape]")
    check(page.is_visible("#shape-menu"), "tapping the shape tool drops its menu down")
    button = page.eval_on_selector("[data-tool=shape]", "b => { const r = b.getBoundingClientRect(); return [r.left, r.right, r.bottom]; }")
    menu = page.eval_on_selector("#shape-menu", "m => { const r = m.getBoundingClientRect(); return [r.left, r.right, r.top]; }")
    check(menu[2] >= button[2] and menu[0] < button[1] and menu[1] > button[0], f"the menu sits right under the button: {button} {menu}")
    page.click("[data-shape=rect]")
    check(page.is_hidden("#shape-menu"), "picking a shape closes the menu")

    def drag(a, b, shift=False):
        page.evaluate("""async ({a, b, shift}) => {
          const canvas = document.getElementById('paper'); const rect = canvas.getBoundingClientRect();
          const at = ([x, y]) => { const [sx, sy] = window.drawingRoom.paperToScreen(x, y); return [rect.left + sx, rect.top + sy]; };
          const fire = (name, p) => { const [cx, cy] = at(p); canvas.dispatchEvent(new PointerEvent(name, {pointerId: 9,
            pointerType: 'mouse', clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0,
            buttons: name === 'pointerup' ? 0 : 1, isPrimary: true, shiftKey: shift})); };
          fire('pointerdown', a);
          for (let i = 1; i <= 10; i++) fire('pointermove', [a[0] + (b[0] - a[0]) * i / 10, a[1] + (b[1] - a[1]) * i / 10]);
          fire('pointerup', b); }""", {"a": a, "b": b, "shift": shift})
        page.wait_for_timeout(100)

    for kind, a, b, shift in (("rect", [80, 80], [300, 220], False), ("rect", [380, 80], [520, 160], True),
                              ("triangle", [600, 80], [900, 330], False), ("ellipse", [80, 420], [380, 640], False),
                              ("line", [500, 450], [900, 520], True)):
        page.click("[data-tool=shape]")
        page.click(f"[data-shape={kind}]")
        check(page.inner_text("#shape-icon") == {"line": "╱", "rect": "▭", "ellipse": "◯", "triangle": "△"}[kind], f"the button shows {kind}")
        drag(a, b, shift)
    shapes = page.evaluate(SHAPES)
    check([s["shape"] for s in shapes] == ["rect", "rect", "triangle", "ellipse", "line"], f"five shapes: {[s['shape'] for s in shapes]}")
    pts = lambda s: [(round(p[0]), round(p[1])) for p in s["points"]]
    check({(80, 80), (300, 80), (300, 220), (80, 220)} <= set(pts(shapes[0])), "the rectangle has its four corners")
    xs = [p[0] for p in shapes[1]["points"]]; ys = [p[1] for p in shapes[1]["points"]]
    check(round(max(xs) - min(xs)) == round(max(ys) - min(ys)) == 140, "Shift makes a square")
    end = shapes[4]["points"][-1]; start = shapes[4]["points"][0]
    angle = math.degrees(math.atan2(end[1] - start[1], end[0] - start[0]))
    check(abs(angle - round(angle / 15) * 15) < 0.01, f"Shift snaps the line to 15°: {angle:.2f}°")
    drag([700, 700], [701, 700])
    check(len(page.evaluate(SHAPES)) == 5, "a click without a drag draws nothing")
    check(reddish(page.evaluate(PIXEL, [190, 80])), "the rectangle is drawn in the shared colour")

    # Shapes hold paint, and never count for the score.
    page.click("[data-tool=fill]")
    tap(page, 750, 250)
    check(reddish(page.evaluate(PIXEL, [750, 250])) and page.evaluate(PIXEL, [620, 120]) == [255, 255, 255],
          "the triangle fills inside and stays white outside")
    page.click("[data-tool=shape]")
    page.screenshot(path=f"{OUT}/17-shapes.png")
    page.evaluate("() => { const s = window.drawingRoom.state; s.activeLayer = 'line'; }")
    score = page.evaluate("""async () => { const s = window.drawingRoom.state;
      const strokes = s.history.doc.layers.flatMap(l => l.strokes.filter(x => x.tool !== 'fill').map(x => ({...x, scored: true})));
      const r = await fetch('/api/score', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({level: 2, reference: {id: 'circle'}, strokes})}); return (await r.json()).shape; }""")
    check(score == 0, f"shapes do not score: {score}")

    # The colour picker: take the triangle's red, then go back to the shape tool.
    COLOR = "() => window.drawingRoom.state.tools.pencil.color"
    page.evaluate("() => { const s = window.drawingRoom.state; for (const t of Object.values(s.tools)) if (t.color) t.color = '#2255cc'; }")
    page.click("[data-tool=shape]")
    page.keyboard.press("Escape")
    page.keyboard.press("k")
    check(page.evaluate("() => window.drawingRoom.state.tool") == "picker", "K picks the colour picker")
    tap(page, 750, 250)
    check(page.evaluate(COLOR) == "#e0403a", f"the picker takes the fill's colour: {page.evaluate(COLOR)}")
    check(page.evaluate("() => window.drawingRoom.state.tool") == "shape", "and hands back to the shape tool")
    check(page.input_value("#color") == "#e0403a", "the swatch shows it")
    # Alt-click with a drawing tool picks too, here the bare paper.
    page.evaluate("""() => { const canvas = document.getElementById('paper'); const rect = canvas.getBoundingClientRect();
      const [sx, sy] = window.drawingRoom.paperToScreen(950, 700);
      for (const name of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(name, {pointerId: 9, pointerType: 'mouse',
        clientX: rect.left + sx, clientY: rect.top + sy, bubbles: true, cancelable: true, button: 0, buttons: name === 'pointerup' ? 0 : 1,
        isPrimary: true, altKey: true})); }""")
    page.wait_for_timeout(100)
    check(page.evaluate(COLOR) == "#ffffff" and len(page.evaluate(SHAPES)) == 5, "Alt-click picks the paper's white and draws nothing")
    # From the reference card: its picture's own colour.
    page.click("[data-tool=picker]")
    page.click("#reference-image", position={"x": 5, "y": 5})
    check(page.evaluate(COLOR) == "#ffffff" and page.evaluate("() => window.drawingRoom.state.tool") == "shape",
          "the reference card gives its colour and hands back")

    check(not errors, f"no console errors: {errors}")
    browser.close()

sys.exit(1 if failed else 0)
