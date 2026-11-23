import { test } from "node:test";
import assert from "node:assert/strict";

import { strokesForScoring } from "../src/drawing_room/static/js/layers.js";
import { toHex } from "../src/drawing_room/static/js/picker.js";
import { paintOrder } from "../src/drawing_room/static/js/render.js";
import { strokeHits } from "../src/drawing_room/static/js/strokes.js";

const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
const fill = { id: "f", tool: "fill", outlines: [square], points: square.map(([x, y]) => [x, y, 0.5, 0, 0, 0]) };
const line = { id: "l", tool: "pencil", size: 2, points: [[0, 0, 0.5, 0, 0, 0], [100, 0, 0.5, 1, 0, 0]] };

test("bucket fills paint under the layer's lines, and keep the lines' own order otherwise", () => {
  const other = { ...line, id: "m" };
  assert.deepEqual(paintOrder([line, fill, other]).map((s) => s.id), ["f", "l", "m"]);
  const plain = [line, other];
  assert.equal(paintOrder(plain), plain);
});

test("a fill is hit anywhere inside it, and nowhere outside", () => {
  assert.ok(strokeHits(fill, 50, 50, 1));
  assert.ok(!strokeHits(fill, 150, 50, 1));
  // A hole (the inner loop winding the other way) is not part of the fill.
  const ring = { ...fill, outlines: [square, [[25, 25], [25, 75], [75, 75], [75, 25]]] };
  assert.ok(!strokeHits(ring, 50, 50, 1) && strokeHits(ring, 10, 50, 1));
});

test("fills never reach scoring or the coach", () => {
  const doc = { layers: [{ id: "a", visible: true, scored: true, strokes: [line, fill] }] };
  assert.deepEqual(strokesForScoring(doc).map((s) => s.id), ["l"]);
});

test("picked colours come back as hex", () => {
  assert.equal(toHex([255, 0, 16.4]), "#ff0010");
});
