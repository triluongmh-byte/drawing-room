"""Browser check for projects (new, open, rename, delete, shared between devices) and the full-width paper.

Needs a running server with an EMPTY data directory (never your real one). Run:
    uv run drawing-room serve --port 8431 --data "$(mktemp -d)" &
    uv run --with playwright python scripts/e2e_projects.py http://127.0.0.1:8431/ docs/screenshots
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
        page.goto(URL)
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
    corner = mac.evaluate("""() => [...document.getElementById('paper').getContext('2d').getImageData(3, 3, 1, 1).data]""")
    check(max(corner[:3]) < 80, f"outside the sheet is the dark desk: {corner}")
    check(mac.evaluate(PIXEL, [500, 20])[:3] == [255, 255, 255], "the sheet is white")
    mac.click("#project-button")
    mac.select_option("#paper-size", "a4-portrait")
    mac.keyboard.press("Escape")
    mac.wait_for_timeout(200)  # the next animation frame draws the new sheet
    check(mac.evaluate(PIXEL, [500, 1000])[:3] == [255, 255, 255], "an A4 portrait sheet reaches below the frame")
    mac.evaluate("() => window.drawingRoom.flush()")
    mac.reload(); ready(mac)
    check(mac.evaluate("() => window.drawingRoom.state.paper") == "a4-portrait", "the paper size is kept with the project")

    # New project, named straight away.
    mac.click("#project-button")
    mac.click("#project-new")
    mac.wait_for_function("() => document.activeElement && document.activeElement.id === 'project-rename'")
    check(mac.evaluate(COUNT) == 0, "a new project starts empty")
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

    # The save note says when the work is on the computer.
    mac.wait_for_function("() => document.getElementById('project-status').textContent === 'Saved ✓'")
    draw(mac, 300)
    check(mac.text_content("#project-status") == "Saving…", "a change shows Saving…")
    mac.wait_for_function("() => document.getElementById('project-status').textContent === 'Saved ✓'")
    check(True, "then Saved ✓")

    # Export the sheet as PNG and JPG: the sheet's size at 2 px per unit, white paper, dark strokes.
    import io, json
    from PIL import Image
    mac.click("#project-button")
    for fmt, kind in (("png", "PNG"), ("jpg", "JPEG")):
        with mac.expect_download() as info:
            mac.click(f"#export-{fmt}")
        download = info.value
        data = open(download.path(), "rb").read()
        image = Image.open(io.BytesIO(data))
        check(download.suggested_filename.endswith(f".{fmt}") and image.format == kind,
              f"export {fmt}: {download.suggested_filename} is {image.format}")
        sheet = mac.evaluate("() => window.drawingRoom.state.paper")
        check(image.size == (2000, 1500), f"export {fmt} covers the whole {sheet} sheet: {image.size}")
        gray = image.convert("L")
        check(gray.getpixel((5, 5)) > 245 and gray.getextrema()[0] < 120, f"export {fmt}: white paper with dark strokes")

    # Save the project to a file and open it again as a new project with the same strokes.
    strokes = mac.evaluate(COUNT)
    with mac.expect_download() as info:
        mac.click("#file-save")
    saved_file = info.value
    content = json.loads(open(saved_file.path(), encoding="utf-8").read())
    check(saved_file.suggested_filename.endswith(".drawing.json") and content["format"] == "drawing-room",
          f"project file: {saved_file.suggested_filename}")
    before = mac.evaluate("async () => (await (await fetch('/api/projects')).json()).projects.length")
    old_id = mac.evaluate("() => window.drawingRoom.state.project.id")
    mac.set_input_files("#file-input", saved_file.path())
    mac.wait_for_function(f"async () => (await (await fetch('/api/projects')).json()).projects.length === {before + 1}")
    mac.wait_for_function(f"() => window.drawingRoom.state.project.id !== '{old_id}'")
    check(mac.evaluate(COUNT) == strokes, f"the opened file has the same {strokes} strokes")
    check(mac.evaluate(NAME) == "Apple study" and mac.evaluate("() => window.drawingRoom.state.project.id") != old_id,
          "the file opens as a new project with its name and strokes")
    # Clean up the copy so the delete checks below see the same projects as before.
    mac.once("dialog", lambda d: d.accept())
    if mac.is_hidden("#project-menu"):
        mac.click("#project-button")
    mac.click("#project-delete")
    mac.wait_for_function(f"async () => (await (await fetch('/api/projects')).json()).projects.length === {before}")
    mac.wait_for_function("() => window.drawingRoom.state.project?.name === 'Apple study'")

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

    top = mac.eval_on_selector_all(".toolbar > *:not([hidden])", "els => { const mids = els.map(e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }); return Math.max(...mids) - Math.min(...mids); }")
    check(top < 8, "the toolbar is still one row at 1180 px")
    check(not errors, f"no console errors: {errors}")
    browser.close()

sys.exit(1 if failed else 0)
