"""End-to-end check in a real browser: draws with synthetic pen events, scores, asks the coach, saves screenshots.

Needs a running server on port 8430 and Google Chrome. Run:
    uv run drawing-room serve &
    uv run --with playwright python scripts/e2e_browser.py docs/screenshots
"""
import json, math, sys, time
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8430/"
OUT = sys.argv[1]

DRAW = """
async ({points, type, id}) => {
  const canvas = document.getElementById('paper');
  const rect = canvas.getBoundingClientRect();
  const at = ([x, y]) => { const [sx, sy] = window.drawingRoom.paperToScreen(x, y); return [rect.left + sx, rect.top + sy]; };
  const fire = (name, p, pressure) => {
    const [cx, cy] = at(p);
    canvas.dispatchEvent(new PointerEvent(name, {pointerId: id, pointerType: type, clientX: cx, clientY: cy,
      pressure, tiltX: 20, tiltY: -10, bubbles: true, cancelable: true, button: 0, buttons: name === 'pointerup' ? 0 : 1, isPrimary: true}));
  };
  fire('pointerdown', points[0], 0.3);
  for (let i = 1; i < points.length; i++) {
    fire('pointermove', points[i], 0.3 + 0.5 * Math.sin(Math.PI * i / points.length));
    if (i % 8 === 0) await new Promise(r => setTimeout(r, 4));
  }
  fire('pointerup', points[points.length - 1], 0);
}
"""

def ellipse(cx, cy, rx, ry, n=120, wobble=0.0):
    return [[cx + (rx + wobble * math.sin(7 * t / n * 2 * math.pi)) * math.cos(2 * math.pi * t / n),
             cy + (ry + wobble * math.sin(7 * t / n * 2 * math.pi)) * math.sin(2 * math.pi * t / n)] for t in range(n + 1)]

def line(a, b, n=40):
    return [[a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n] for i in range(n + 1)]

def strokes_count(page):
    return page.evaluate("() => Object.values(window.drawingRoom.state.history.doc.layers).reduce((a, l) => a + l.length, 0)")

def score_text(page):
    return page.inner_text("#score-shape"), page.inner_text("#score-proportion"), page.inner_text("#score-detail")

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=2)
    logs = []
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
    page.goto(URL)
    page.wait_for_function("() => window.drawingRoom && window.drawingRoom.state.references.length > 0")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("() => window.drawingRoom.state.references.length > 0")

    # Level 0 drill: straight line between two dots, auto-scored.
    page.select_option("#level", "0")
    page.select_option("#reference", "line")
    page.wait_for_timeout(300)
    page.evaluate(DRAW, {"points": line((252, 468), (748, 293)), "type": "pen", "id": 1})
    page.click("#score-button")
    page.wait_for_function("() => document.getElementById('score-shape').textContent !== '–'")
    print("level0 line:", score_text(page))
    page.screenshot(path=f"{OUT}/01-level0-line-drill.png")

    # Level 1, cube: guided steps; draw the front face only and watch the guide move to step 2.
    page.evaluate("() => { window.drawingRoom.state.history.clear(); }")
    page.select_option("#level", "1")
    page.select_option("#reference", "cube")
    page.wait_for_timeout(300)
    front = [[300, 285], [580, 285], [580, 565], [300, 565], [300, 285]]
    pts = []
    for a, b in zip(front, front[1:]):
        pts += line(a, b, 30)
    page.evaluate(DRAW, {"points": pts, "type": "pen", "id": 2})
    page.wait_for_function("() => document.querySelector('#steps li.current') && document.querySelector('#steps li.current').textContent.includes('back face')", timeout=10000)
    print("level1 next step:", page.inner_text("#next-step"))
    page.screenshot(path=f"{OUT}/02-level1-cube-next-step.png")

    # Palm rejection: a pen was seen, so a touch drag must not draw.
    before = strokes_count(page)
    page.evaluate(DRAW, {"points": line((100, 100), (200, 200)), "type": "touch", "id": 9})
    after = strokes_count(page)
    moved = page.evaluate("() => window.drawingRoom.state.view")
    print("palm rejection: strokes before/after touch =", before, after, "; touch panned view to", moved["x"], moved["y"])
    assert before == after
    page.keyboard.press("0")

    # Level 2, circle with an offset trace: score, then ask the coach.
    page.evaluate("() => { window.drawingRoom.state.history.clear(); }")
    page.select_option("#level", "2")
    page.select_option("#reference", "circle")
    page.wait_for_timeout(300)
    page.evaluate(DRAW, {"points": ellipse(530, 380, 215, 200, wobble=6), "type": "pen", "id": 3})
    page.click("#score-button")
    page.wait_for_function("() => document.getElementById('score-shape').textContent !== '–'")
    print("level2 circle:", score_text(page))
    page.fill("#question", "Why does my circle look off?")
    t0 = time.time()
    page.click("#ask-button")
    page.wait_for_function("() => !document.querySelector('#coach-reply .thinking')", timeout=300000)
    reply = page.inner_text("#coach-reply")
    print(f"coach ({time.time() - t0:.0f}s):", reply)
    page.screenshot(path=f"{OUT}/03-level2-circle-coach.png")

    # Level 3: draw the circle small and off-centre; alignment means no penalty.
    page.evaluate("() => { window.drawingRoom.state.history.clear(); window.drawingRoom.state.marks = []; }")
    page.select_option("#level", "3")
    page.select_option("#reference", "circle")
    page.wait_for_timeout(300)
    page.evaluate(DRAW, {"points": ellipse(300, 260, 120, 120), "type": "pen", "id": 4})
    page.click("#score-button")
    page.wait_for_function("() => document.getElementById('score-shape').textContent !== '–'")
    print("level3 small circle:", score_text(page))
    page.screenshot(path=f"{OUT}/04-level3-small-circle.png")

    # Level 3 squashed circle loses Proportion.
    page.evaluate("() => { window.drawingRoom.state.history.clear(); document.getElementById('score-shape').textContent = '–'; }")
    page.evaluate(DRAW, {"points": ellipse(500, 375, 220, 130), "type": "pen", "id": 5})
    page.click("#score-button")
    page.wait_for_function("() => document.getElementById('score-shape').textContent !== '–'")
    print("level3 squashed:", score_text(page))
    page.screenshot(path=f"{OUT}/05-level3-squashed.png")

    # Undo via keyboard, zoom via wheel, rotate.
    n = strokes_count(page)
    page.keyboard.press("Meta+z")
    print("undo:", n, "->", strokes_count(page))
    page.keyboard.press("Meta+Shift+z")
    print("redo:", strokes_count(page))
    page.mouse.move(600, 450)
    page.mouse.wheel(0, -300)
    page.keyboard.press("r")
    page.wait_for_timeout(200)
    print("view:", page.evaluate("() => window.drawingRoom.state.view"))
    page.screenshot(path=f"{OUT}/06-zoom-rotate.png")
    print("console:", logs)
    browser.close()
