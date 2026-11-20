"""Browser check for projects (new, open, rename, delete, shared between devices) and the full-width paper.

Needs Google Chrome and a running server with an EMPTY, throwaway data directory (never your real projects, never
the server you draw on). Screenshots go to the folder given; the README's pictures live in docs/screenshots. Run:
    uv run drawing-room serve --port 8499 --data "$(mktemp -d)" &
    uv run --with playwright python scripts/e2e_projects.py http://127.0.0.1:8499/ "$(mktemp -d)"
"""
import sys
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
COUNT = "() => window.drawingRoom.state.history.doc.layers.reduce((n, l) => n + l.strokes.length, 0)"
NAME = "() => window.drawingRoom.state.project && window.drawingRoom.state.project.name"
failed = False


def check(cond, msg):
    global failed
    print(("PASS " if cond else "FAIL ") + msg)
    failed |= not cond


def ready(page):
    page.wait_for_function("() => window.drawingRoom.state.project", timeout=10000)
    page.wait_for_timeout(300)


def draw(page, y):
    page.evaluate(DRAW, {"points": [[x, y] for x in range(100, 400, 5)]})
    page.wait_for_timeout(50)


def saved(page):
    page.evaluate("() => window.drawingRoom.flush()")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    errors = []

    def new_device(width=1180, height=820, legacy=None):
        context = browser.new_context(viewport={"width": width, "height": height})
        if legacy:
            context.add_init_script(f"if (!localStorage.getItem('drawing-room:v0-migrated')) localStorage.setItem('drawing-room:v0', {legacy!r});")
        page = context.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL + "?practice")
        ready(page)
        return page

    # A drawing from before projects becomes the first project.
    legacy = '{"level": 2, "layers": [{"id": "line", "name": "Line", "strokes": [{"id": "a", "tool": "ink", "size": 4, "color": "#111111", "points": [[100, 100, 0.5, 0], [300, 300, 0.5, 9]]}]}]}'
    mac = new_device(legacy=legacy)
    check(not mac.is_visible("#pin-overlay"), "no PIN asked")
    check(mac.evaluate(NAME) == "My first drawing" and mac.evaluate(COUNT) == 1, "the old drawing became the first project")
    check(mac.input_value("#level") == "2", "with its level")

    # A white sheet on a dark desk; the paper size is picked in the project menu and kept with the project.
    PIXEL = """([x, y]) => { const c = document.getElementById('paper'); const r = c.getBoundingClientRect();
      const [sx, sy] = window.drawingRoom.paperToScreen(x, y); const k = c.width / r.width;
      return [...c.getContext('2d').getImageData(Math.round(sx * k), Math.round(sy * k), 1, 1).data]; }"""
    # White paper edge to edge with no border; the grid (on by default, G toggles it) pans with the drawing.
    check(mac.evaluate("() => window.drawingRoom.state.grid") is True, "the grid is on by default")
    check(mac.get_attribute("#grid-toggle", "aria-pressed") == "true", "the grid button shows it is on")
    mac.wait_for_timeout(100)
    # Darkest pixel across the line at x 250 (a 1 px line falls between device pixels).
    STRIP = """([x, y]) => { const c = document.getElementById('paper'); const r = c.getBoundingClientRect();
      const [sx, sy] = window.drawingRoom.paperToScreen(x, y); const k = c.width / r.width;
      const d = c.getContext('2d').getImageData(Math.round(sx * k) - 3, Math.round(sy * k), 7, 1).data;
      let m = 255; for (let i = 0; i < d.length; i += 4) m = Math.min(m, d[i]); return m; }"""
    on_line = mac.evaluate(STRIP, [250, 120])
    check(180 < on_line < 240, f"a faint grid line at x 250: {on_line}")
    mac.click("#grid-toggle")
    mac.wait_for_timeout(100)
    corner = mac.evaluate("""() => [...document.getElementById('paper').getContext('2d').getImageData(3, 3, 1, 1).data]""")
    check(corner[:3] == [245, 245, 242], f"with the grid off, even the screen corner is the off-white paper: {corner}")
    check(mac.evaluate(STRIP, [250, 120]) == 245, "the grid line is gone")
    mac.keyboard.press("g")
    check(mac.evaluate("() => window.drawingRoom.state.grid") is True, "G brings the grid back")
    # The paper has no edge: a stroke running past the sheet still shows.
    mac.evaluate(DRAW, {"points": [[x, 700] for x in range(900, 1100, 5)]})
    mac.wait_for_timeout(100)
    check(mac.evaluate(PIXEL, [1060, 700])[:3] != [245, 245, 242], "a stroke past the sheet's edge is drawn")
    mac.keyboard.press("Meta+z" if sys.platform == "darwin" else "Control+z")
    mac.wait_for_timeout(100)
    mac.click("#project-button")
    mac.select_option("#paper-size", "a4-portrait")
    mac.keyboard.press("Escape")
    bottom = mac.evaluate("() => window.drawingRoom.paperToScreen(500, 1150)[1] < document.getElementById('paper').getBoundingClientRect().height")
    check(bottom, "the view fits the A4 portrait sheet, below the frame")
    mac.evaluate("() => window.drawingRoom.flush()")
    mac.reload(); ready(mac)
    check(mac.evaluate("() => window.drawingRoom.state.paper") == "a4-portrait", "the paper size is kept with the project")

    # New project, named straight away. It starts on blank paper even when this one draws from a reference.
    mac.eval_on_selector("#reference", "el => { el.value = 'line'; el.dispatchEvent(new Event('change')); }")
    check(mac.evaluate("() => window.drawingRoom.state.reference?.id") == "line", "this project draws from the line")
    mac.click("#project-button")
    mac.click("#project-new")
    mac.wait_for_function("() => document.activeElement && document.activeElement.id === 'project-rename'")
    check(mac.evaluate(COUNT) == 0, "a new project starts empty")
    check(mac.evaluate("() => window.drawingRoom.state.reference") is None, "a new project starts on blank paper")
    mac.fill("#project-rename", "Apple study")
    mac.press("#project-rename", "Enter")
    mac.wait_for_function("() => window.drawingRoom.state.project?.name === 'Apple study'")
    check(mac.inner_text("#project-name") == "Apple study", "renamed in the toolbar")
    draw(mac, 200); draw(mac, 260)
    saved(mac)
    mac.keyboard.press("Escape")

    # Switch back and forth.
    mac.click("#project-button")
    mac.wait_for_selector("#project-menu", state="visible")
    items = mac.eval_on_selector_all("#project-list li", "els => els.map(e => e.querySelector('.name').textContent)")
    check(items == ["Apple study", "My first drawing"], f"newest first: {items}")
    mac.screenshot(path=f"{OUT}/13-projects.png")
    mac.click("#project-list li:has-text('My first drawing')")
    mac.wait_for_function("() => window.drawingRoom.state.project?.name === 'My first drawing'")
    check(mac.evaluate(COUNT) == 1, "opening the other project shows its drawing")

    # The iPad sees the same projects, opens the latest, and its strokes reach the Mac.
    ipad = new_device(1180, 820)
    check(ipad.evaluate(NAME) == "Apple study" and ipad.evaluate(COUNT) == 2, "another device opens the latest project")
    draw(ipad, 320)
    saved(ipad)
    mac.click("#project-button")
    mac.click("#project-list li:has-text('Apple study')")
    mac.wait_for_function("() => window.drawingRoom.state.project?.name === 'Apple study'")
    check(mac.evaluate(COUNT) == 3, "strokes drawn on the other device show up")

    # Changes are saved without pressing anything, and survive a reload.
    draw(mac, 380)
    mac.wait_for_timeout(1800)
    mac.reload(); ready(mac)
    check(mac.evaluate(NAME) == "Apple study" and mac.evaluate(COUNT) == 4, "autosaved and reopened after a reload")
    # Reloading straight after a stroke, before the autosave: nothing is lost.
    draw(mac, 440)
    mac.reload(); ready(mac)
    check(mac.evaluate(COUNT) == 5, f"a stroke right before a reload is kept: {mac.evaluate(COUNT)}")
    saved(mac)
    mac.screenshot(path=f"{OUT}/14-full-paper.png")

    # Delete: the open project goes, the next one opens.
    mac.once("dialog", lambda d: d.accept())
    mac.click("#project-button")
    mac.click("#project-delete")
    mac.wait_for_function("() => window.drawingRoom.state.project?.name === 'My first drawing'")
    names = mac.evaluate("async () => (await (await fetch('/api/projects')).json()).projects.map(p => p.name)")
    check(names == ["My first drawing"], f"deleted on the server: {names}")
    # Deleting the last one leaves a fresh empty project.
    mac.once("dialog", lambda d: d.accept())
    mac.click("#project-button")
    mac.click("#project-delete")
    mac.wait_for_function("() => window.drawingRoom.state.project && window.drawingRoom.state.project.name !== 'My first drawing'")
    check(mac.evaluate(COUNT) == 0, f"never zero projects: {mac.evaluate(NAME)}")

    top = mac.eval_on_selector_all("header > *:not([hidden]):not(select)", "els => { const mids = els.map(e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }); return Math.max(...mids) - Math.min(...mids); }")
    check(top < 8, "the toolbar is still one row at 1180 px")

    # Without ?practice the app is free drawing: no practice menu, no score or reference panels, and a project
    # saved with a reference opens on blank paper (the reference stays in the file).
    mac.eval_on_selector("#reference", "el => { el.value = 'line'; el.dispatchEvent(new Event('change')); }")
    saved(mac)
    free = mac.context.new_page()
    free.on("pageerror", lambda e: errors.append(str(e)))
    free.goto(URL)
    ready(free)
    check(not free.is_visible("#mode-button"), "free drawing: no practice menu")
    check(not free.is_visible("[data-panel-toggle=coach]") and not free.is_visible("[data-panel-toggle=reference]"),
          "free drawing: no score or reference buttons")
    check(not free.is_visible("#panel-reference") and not free.is_visible("#panel-coach"), "free drawing: their panels stay shut")
    check(free.evaluate("() => window.drawingRoom.state.reference") is None, "free drawing: a saved reference is not shown")
    check(free.evaluate("() => window.drawingRoom.state.underlay") is None, "free drawing: nothing under the paper")
    check(free.is_visible("#toolbox") and free.is_visible("[data-panel-toggle=chat]"), "free drawing: tools and Claude stay")
    check(not errors, f"no console errors: {errors}")
    browser.close()

sys.exit(1 if failed else 0)
