import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_H, FRAME_W, PAPERS, paperId, sheetRect, COORD_LIMIT, drawingBounds, fitBoxes, gridLines } from "../src/drawing_room/static/js/paper.js";

test("the default sheet is exactly the reference frame", () => {
  assert.deepEqual(sheetRect("frame"), [0, 0, FRAME_W, FRAME_H]);
  assert.equal(paperId("nonsense"), "frame");
  assert.equal(paperId("__proto__"), "frame");
});

test("every sheet holds the whole frame, centred, at its own aspect", () => {
  for (const [id, { aspect }] of Object.entries(PAPERS)) {
    const [x0, y0, x1, y1] = sheetRect(id);
    assert.ok(x0 <= 0 && y0 <= 0 && x1 >= FRAME_W && y1 >= FRAME_H, id);
    assert.ok(Math.abs((x0 + x1) / 2 - FRAME_W / 2) < 0.1 && Math.abs((y0 + y1) / 2 - FRAME_H / 2) < 0.1, id);
    assert.ok(Math.abs((x1 - x0) / (y1 - y0) - aspect) < 0.01, id);
    assert.ok(x1 - x0 === FRAME_W || y1 - y0 === FRAME_H, `${id} is as small as it can be`);
  }
});

test("the drawn area is the sheet grown to hold strokes past its edge, within the coordinate limit", () => {
  const sheet = [0, 0, 1000, 750];
  assert.deepEqual(drawingBounds(sheet, []), sheet);
  assert.deepEqual(drawingBounds(sheet, [null, { x0: 100, y0: 100, x1: 200, y1: 200 }]), sheet);
  assert.deepEqual(drawingBounds(sheet, [{ x0: -300, y0: 50, x1: 1200, y1: 900 }]), [-300, 0, 1200, 900]);
  assert.deepEqual(drawingBounds(sheet, [{ x0: -9e9, y0: 0, x1: 10, y1: NaN }, { x0: -9e9, y0: 0, x1: 10, y1: 9e9 }]), [-COORD_LIMIT, 0, 1000, COORD_LIMIT]);
});

test("grid lines every 50 units, every fifth major, coarser when zoomed far out", () => {
  const lines = gridLines([-10, 0, 260, 100], 1);
  assert.equal(lines.step, 50);
  assert.deepEqual(lines.major.x, [0, 250]);
  assert.deepEqual(lines.minor.x, [50, 100, 150, 200]);
  assert.deepEqual(lines.major.y, [0]);
  assert.deepEqual(lines.minor.y, [50, 100]);
  assert.equal(gridLines([0, 0, 5000, 5000], 0.1).step, 250); // 50 units would be 5 px apart
});

test("a layer picture zooms onto that layer's own strokes, with a margin", () => {
  assert.equal(fitBoxes([], 100, 50), null);
  const { scale, dx, dy } = fitBoxes([{ x0: 400, y0: 300, x1: 600, y1: 400 }, null], 100, 50, { margin: 0 });
  assert.equal(scale, 0.5); // 200 x 100 units fill 100 x 50 px
  assert.deepEqual([400 * scale + dx, 300 * scale + dy, 600 * scale + dx, 400 * scale + dy], [0, 0, 100, 50]);
  const dot = fitBoxes([{ x0: 10, y0: 10, x1: 11, y1: 11 }], 100, 50, { margin: 0, minSpan: 80 });
  assert.equal(dot.scale, 100 / 80); // a dot is not blown up to fill the card
});
