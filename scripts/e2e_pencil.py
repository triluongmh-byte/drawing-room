"""Browser check for the pencil, the Shade tool and the one-row toolbar, with synthetic pen and mouse events.

Needs Google Chrome and a running server with an EMPTY, throwaway data directory (never your real projects, never
the server you draw on). Screenshots go to the folder given; the README's pictures live in docs/screenshots. Run:
    uv run drawing-room serve --port 8499 --data "$(mktemp -d)" &
    uv run --with playwright python scripts/e2e_pencil.py http://127.0.0.1:8499/ "$(mktemp -d)"
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
async ({points, type}) => {
  const canvas = document.getElementById('paper');
  const rect = canvas.getBoundingClientRect();
  const at = ([x, y]) => { const [sx, sy] = window.drawingRoom.paperToScreen(x, y); return [rect.left + sx, rect.top + sy]; };
  const fire = (name, p) => {
    const [cx, cy] = at(p);
    canvas.dispatchEvent(new PointerEvent(name, {pointerId: 5, pointerType: type, clientX: cx, clientY: cy,
      pressure: p[2] ?? 0.5, tiltX: p[3] ?? 0, tiltY: 0, bubbles: true, cancelable: true, button: 0,
      buttons: name === 'pointerup' ? 0 : 1, isPrimary: true}));
  };
  fire('pointerdown', points[0]);
  for (let i = 1; i < points.length; i++) fire('pointermove', points[i]);
  fire('pointerup', points[points.length - 1]);
}
"""
STROKES = "() => window.drawingRoom.state.history.doc.layers.flatMap(l => l.strokes.map(s => ({tool: s.tool, shade: !!s.shade, opacity: s.opacity, size: s.size, color: s.color})))"

failed = False


def check(cond, msg):
    global failed
    print(("PASS " if cond else "FAIL ") + msg)
    failed |= not cond


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1180, "height": 820})  # iPad Air / Pro 11" landscape
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL + "?practice")
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_timeout(800)

    top = page.eval_on_selector_all("header > *:not([hidden]):not(select)", "els => { const mids = els.map(e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }); return Math.max(...mids) - Math.min(...mids) < 8 ? 1 : 2; }")
    check(top == 1, "the top bar is one row at 1180 px")
    check(not page.is_visible("#ruler-angle"), "the ruler angle hides while the ruler is off")

    pick(page, "#level", "2")
    pick(page, "#reference", "circle")
    page.wait_for_timeout(300)

    def draw(points, kind="pen"):
        page.evaluate(DRAW, {"points": points, "type": kind})
        page.wait_for_timeout(30)

    # Pressure: thin pale line vs thick dark line.
    tool(page, "pencil")
    draw([[100 + i * 3, 100, 0.1, 0] for i in range(80)])
    draw([[100 + i * 3, 160, 0.95, 0] for i in range(80)])
    light, firm = page.evaluate(STROKES)
    check(light["opacity"] < firm["opacity"] and not light["shade"], f"a light touch is paler: {light['opacity']} < {firm['opacity']}")

    # A pen laid on its side shades.
    draw([[420 + i * 2, 100 + i, 0.6, 70] for i in range(80)])
    tilted = page.evaluate(STROKES)[-1]
    check(tilted["shade"] and tilted["opacity"] < 0.45, f"a tilted pen shades lightly: {tilted}")

    # The Shade tool lays the pencil flat for a mouse or trackpad, at its own size.
    tool(page, "shade")
    check(page.input_value("#size") == "26", f"Shade has its own size: {page.input_value('#size')}")
    page.eval_on_selector("#size", "el => { el.value = '40'; el.dispatchEvent(new Event('input')); }")
    for k in range(4):
        draw([[480 + 140 * math.cos(a / 30) + k * 10, 360 + 140 * math.sin(a / 30) + k * 8] for a in range(30, 120)], "mouse")
    shade = page.evaluate(STROKES)[-1]
    check(shade["tool"] == "shade" and shade["shade"] and shade["size"] == 40, f"Shade strokes are shading at size 40: {shade}")

    # Colored pencil: a picked colour is used straight away, even when the picker only sends `change` (Safari),
    # and it stays when switching tools.
    tool(page, "pencil")
    check(page.input_value("#size") == "3", "the pencil kept its own size")
    page.eval_on_selector("#color", "el => { el.value = '#2f6fd0'; el.dispatchEvent(new Event('change')); }")
    draw([[500 + 220 * math.cos(a / 60), 375 + 220 * math.sin(a / 60), 0.7, 0] for a in range(0, 380)])
    check(page.evaluate(STROKES)[-1]["color"] == "#2f6fd0", "the pencil draws in the picked colour (change only)")
    tool(page, "ink")
    check(page.input_value("#color") == "#2f6fd0", "the ink keeps the picked colour")
    tool(page, "brush")
    page.eval_on_selector("#color", "el => { el.value = '#e0604a'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }")
    tool(page, "pencil")
    check(page.input_value("#color") == "#2f6fd0", "back on the pencil, it keeps its own group's colour, not the brush's")
    tool(page, "highlighter")
    check(page.input_value("#color") == "#e0604a", "the highlighter shares the paint group's colour")
    tool(page, "eraser")
    check(not page.is_visible("#color"), "the eraser has no colour")

    page.screenshot(path=f"{OUT}/11-pencil.png")

    # Shading is tone, not line: the circle alone scores the same with or without it.
    page.eval_on_selector("#score-button", "b => b.click()"); page.wait_for_timeout(600)
    detail = page.inner_text("#score-detail")
    count = sum(1 for s in page.evaluate(STROKES) if not s["shade"])
    check(f"{count} strokes" in detail, f"only lines are scored ({count}): {detail!r}")

    # Settings survive a reload.
    page.reload(); page.wait_for_timeout(800)
    check(page.evaluate("() => window.drawingRoom.state.tool") == "eraser", "the tool survives a reload")
    tool(page, "shade")
    check(page.input_value("#size") == "40", "tool sizes survive a reload")
    check(page.evaluate(STROKES)[2]["shade"], "shading survives a reload")

    # Portrait: the top bar still fits, nothing hidden off the edge.
    page.set_viewport_size({"width": 820, "height": 1180})
    page.wait_for_timeout(300)
    bar = page.eval_on_selector("header", "el => [el.scrollWidth, el.clientWidth]")
    check(bar[0] <= bar[1], f"portrait top bar fits: {bar}")
    check(page.is_visible("#clear"), "Clear all is reachable in portrait")
    page.screenshot(path=f"{OUT}/12-portrait.png")

    check(not errors, f"no console errors: {errors}")
    browser.close()

sys.exit(1 if failed else 0)
