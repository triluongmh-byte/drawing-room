import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_H, FRAME_W, PAPERS, paperId, sheetRect } from "../src/drawing_room/static/js/paper.js";

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
