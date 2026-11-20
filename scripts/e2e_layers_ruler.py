"""Browser check for layers and the ruler, with synthetic pen events.

Needs Google Chrome and a running server with an EMPTY, throwaway data directory (never your real projects, never
the server you draw on). Screenshots go to the folder given; the README's pictures live in docs/screenshots. Run:
    uv run drawing-room serve --port 8499 --data "$(mktemp -d)" &
    uv run --with playwright python scripts/e2e_layers_ruler.py http://127.0.0.1:8499/ "$(mktemp -d)"
"""
import math, sys
from playwright.sync_api import sync_playwright


# The level and reference live in the practice menu, the tools in the toolbox flyouts: set them the way a tap would.
def pick(page, selector, value):
    page.eval_on_selector(selector, "(el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }", value)


def tool(page, name):
    """Pick a tool from the toolbox: tap its group, then the tool in the flyout; Escape closes the flyout."""
    if name == "eraser":
        page.click("#toolbox [data-tool=eraser]")
        return
    group = "paint" if name in ("brush", "shade", "highlighter") else "write"
    if not page.is_visible(f"#tool-flyout[data-group={group}]"):
        page.click(f"#toolbox [data-group={group}]")
    page.click(f"#tool-flyout [data-tool={name}]")
    page.keyboard.press("Escape")


def open_panel(page, name):
    if page.get_attribute(f"[data-panel-toggle={name}]", "aria-expanded") != "true":
        page.click(f"[data-panel-toggle={name}]")

URL, OUT = sys.argv[1], sys.argv[2]

DRAW = """
async ({points, type, id}) => {
  const canvas = document.getElementById('paper');
  const rect = canvas.getBoundingClientRect();
  const at = ([x, y]) => { const [sx, sy] = window.drawingRoom.paperToScreen(x, y); return [rect.left + sx, rect.top + sy]; };
  const fire = (name, p, pressure, extra = {}) => {
    const [cx, cy] = at(p);
    canvas.dispatchEvent(new PointerEvent(name, {pointerId: id, pointerType: type, clientX: cx, clientY: cy,
      pressure, bubbles: true, cancelable: true, button: 0, buttons: name === 'pointerup' ? 0 : 1, isPrimary: true, ...extra}));
  };
  fire('pointerdown', points[0], 0.4);
  for (let i = 1; i < points.length; i++) fire('pointermove', points[i], 0.5);
  fire('pointerup', points[points.length - 1], 0);
}
"""

def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        global failed
        failed = True

failed = False

def draw(page, points):
    page.evaluate(DRAW, {"points": points, "type": "pen", "id": 7})
    page.wait_for_timeout(50)

def layers(page):
    return page.evaluate("() => window.drawingRoom.state.history.doc.layers.map(l => [l.name, l.strokes.length, l.visible, l.locked, l.scored, l.opacity])")

def ellipse(cx, cy, r, n=120):
    return [[cx + r * math.cos(2 * math.pi * t / n), cy + r * math.sin(2 * math.pi * t / n)] for t in range(n + 1)]

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=2)
    logs = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    page.goto(URL + "?practice")
    page.wait_for_function("() => window.drawingRoom && window.drawingRoom.state.references.length > 0")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("() => window.drawingRoom.state.references.length > 0")
    open_panel(page, "layers")  # the layers float over the paper; open them
    pick(page, "#level", "2")
    pick(page, "#reference", "circle")
    page.wait_for_timeout(300)

    rows = page.eval_on_selector_all("#layers li", "els => els.map(e => e.querySelector('.name').value || e.querySelector('.name').textContent)")
    check(rows == ["Reference", "Sketch", "Line", "Color"], f"default layer rows (DOM order, shown reversed): {rows}")

    # New layer above Sketch, named straight away.
    page.click("#layer-add")
    focused = page.evaluate("() => document.activeElement.matches('#layers input.name') && document.activeElement.value")
    check(focused == "Layer 4", f"new layer's name field is focused with its default name: {focused}")
    page.keyboard.type("Shadows")
    page.keyboard.press("Enter")
    check([l[0] for l in layers(page)] == ["Sketch", "Shadows", "Line", "Color"], f"renamed and placed above Sketch: {layers(page)}")

    draw(page, ellipse(500, 375, 220))
    check(layers(page)[1][1] == 1, "stroke went onto the active layer Shadows")

    # Picking another layer by tapping its row.
    page.click("#layers li[data-layer='line'] .name")
    check(page.evaluate("() => window.drawingRoom.state.activeLayer") == "line", "tapping a row makes it active")
    page.click("#layers li:has-text('Shadows') .name")

    # Lock blocks drawing.
    page.click("#layers li.active button.lock")
    draw(page, ellipse(500, 375, 100))
    check(layers(page)[1][1] == 1 and layers(page)[1][3], "a locked layer takes no strokes")
    check("locked" in page.inner_text("#paper-hint"), f"the hint says why: {page.inner_text('#paper-hint')!r}")
    page.click("#layers li.active button.lock")

    # Opacity and reordering.
    page.eval_on_selector("#layer-opacity", "el => { el.value = '0.4'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }")
    check(abs(layers(page)[1][5] - 0.4) < 1e-9, "layer opacity set to 40%")
    page.click("#layer-up")
    check([l[0] for l in layers(page)] == ["Sketch", "Line", "Shadows", "Color"], "moved up one")
    page.click("#layer-down")
    check([l[0] for l in layers(page)] == ["Sketch", "Shadows", "Line", "Color"], "moved back down")

    # Scoring follows the ★ flag.
    page.eval_on_selector("#score-button", "b => b.click()"); page.wait_for_timeout(600)
    scored_on = page.inner_text("#score-shape")
    page.click("#layers li.active button.scored")
    page.eval_on_selector("#score-button", "b => b.click()"); page.wait_for_timeout(600)
    scored_off = page.inner_text("#score-shape")
    check(float(scored_on) > 0 and float(scored_off) == 0, f"★ decides what is scored: on={scored_on} off={scored_off}")
    page.click("#layers li.active button.scored")

    # Delete, then undo.
    page.click("#layer-delete")
    check("Shadows" not in [l[0] for l in layers(page)], "deleted")
    page.keyboard.press("Meta+z")
    check([l[:2] for l in layers(page)][1] == ["Shadows", 1], f"undo brings the layer and its stroke back: {layers(page)}")
    page.screenshot(path=f"{OUT}/09-layers.png")

    # Ruler.
    page.click("#layers li[data-layer='line'] .name")
    page.keyboard.press("l")
    check(page.evaluate("() => window.drawingRoom.state.rulerOn"), "L turns the ruler on")
    check(page.is_visible("#ruler-angle"), "angle field shows")
    # Drag end b (at 800,375) to about 44 degrees from a (200,375).
    a = page.evaluate("() => window.drawingRoom.state.ruler.a")
    b = page.evaluate("() => window.drawingRoom.state.ruler.b")
    target = [a[0] + 500 * math.cos(math.radians(44)), a[1] - 500 * math.sin(math.radians(44))]
    page.evaluate(DRAW, {"points": [b, [(b[0] + target[0]) / 2, (b[1] + target[1]) / 2], target], "type": "pen", "id": 8})
    angle = page.input_value("#ruler-angle")
    check(angle == "45", f"dragging an end snaps to 45°: {angle}")
    check(layers(page)[2][1] == 0, "dragging the ruler drew nothing")

    # A wobbly stroke starting against the ruler comes out straight on it.
    ruler = page.evaluate("() => window.drawingRoom.state.ruler")
    (ax, ay), (bx, by) = ruler["a"], ruler["b"]
    ux, uy = (bx - ax) / math.hypot(bx - ax, by - ay), (by - ay) / math.hypot(bx - ax, by - ay)
    wobbly = [[ax + ux * d + -uy * (8 + 6 * math.sin(d / 9)), ay + uy * d + ux * (8 + 6 * math.sin(d / 9))] for d in range(60, 400, 4)]
    draw(page, wobbly)
    pts = page.evaluate("() => window.drawingRoom.state.history.doc.layers.find(l => l.id === 'line').strokes.at(-1).points")
    worst = max(abs((x - ax) * -uy + (y - ay) * ux) for x, y, *_ in pts)
    check(len(pts) > 20 and worst < 0.01, f"ruled stroke lies on the ruler (worst off-line {worst:.4f}px over {len(pts)} points)")

    # A stroke far from the ruler is free.
    draw(page, [[100 + i * 3, 650 + 10 * math.sin(i / 5)] for i in range(60)])
    pts = page.evaluate("() => window.drawingRoom.state.history.doc.layers.find(l => l.id === 'line').strokes.at(-1).points")
    check(max(p[1] for p in pts) - min(p[1] for p in pts) > 10, "a stroke away from the ruler stays freehand")

    # Typing an angle.
    page.fill("#ruler-angle", "30")
    page.press("#ruler-angle", "Enter")
    page.evaluate("() => document.getElementById('ruler-angle').blur()")
    check(page.evaluate("() => { const r = window.drawingRoom.state.ruler; return Math.round(Math.atan2(-(r.b[1]-r.a[1]), r.b[0]-r.a[0]) * 180 / Math.PI); }") == 30, "typed angle 30° turns the ruler")
    page.screenshot(path=f"{OUT}/10-ruler.png")

    # Everything survives a reload.
    before = layers(page)
    page.reload()
    page.wait_for_function("() => window.drawingRoom.state.references.length > 0")
    page.wait_for_timeout(300)
    after = layers(page)
    check(before == after, f"layers survive reload: {after}")
    check(page.evaluate("() => window.drawingRoom.state.rulerOn") and page.input_value("#ruler-angle") == "30", "ruler survives reload")

    # Level 0 hides the ruler.
    pick(page, "#level", "0")
    page.wait_for_timeout(200)
    check(not page.is_visible("#ruler-toggle"), "no ruler in warm-up drills")

    check(not logs, f"no console errors: {logs}")
    browser.close()

sys.exit(1 if failed else 0)
