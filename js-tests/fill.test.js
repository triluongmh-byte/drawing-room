import { test } from "node:test";
import assert from "node:assert/strict";

import { dilate, fillArea, flood, insideOutlines, traceOutlines } from "../src/drawing_room/static/js/fill.js";

/** A w x h mask with a square ring of walls from (a, a) to (b, b). */
function ring(w, h, a, b, gapAt = null) {
  const walls = new Uint8Array(w * h);
  for (let i = a; i <= b; i++) {
    for (const [x, y] of [[i, a], [i, b], [a, i], [b, i]]) walls[y * w + x] = 1;
  }
  if (gapAt) walls[gapAt[1] * w + gapAt[0]] = 0;
  return walls;
}

test("flood fills the inside of a closed ring and nothing outside", () => {
  const walls = ring(20, 20, 4, 15);
  const { area, count } = flood(walls, 20, 20, 10, 10);
  assert.equal(count, 10 * 10);
  assert.equal(area[2 * 20 + 2], 0);
  assert.equal(flood(walls, 20, 20, 4, 4), null, "on a wall");
});

test("a gap leaks unless it is closed", () => {
  const walls = ring(20, 20, 4, 15, [15, 10]);
  assert.ok(flood(walls, 20, 20, 10, 10).count > 300, "leaks through the gap");
  const closed = fillArea(walls, 20, 20, 10, 10, 1);
  assert.equal(closed.area[1 * 20 + 1], 0, "closing the gap keeps the outside clean");
  assert.equal(closed.area[10 * 20 + 10], 1);
});

test("dilate grows a pixel into a square", () => {
  const mask = new Uint8Array(25);
  mask[12] = 1;
  assert.equal(dilate(mask, 5, 5, 1).reduce((a, b) => a + b, 0), 9);
});

test("outlines of a ring with a hole wind both ways and contain the right points", () => {
  const mask = new Uint8Array(100);
  for (let y = 1; y < 9; y++) for (let x = 1; x < 9; x++) if (x < 4 || x > 5 || y < 4 || y > 5) mask[y * 10 + x] = 1;
  const loops = traceOutlines(mask, 10, 10, 0);
  assert.equal(loops.length, 2);
  assert.ok(insideOutlines(loops, 2.5, 2.5));
  assert.ok(!insideOutlines(loops, 5, 5), "the hole stays open");
  assert.ok(!insideOutlines(loops, 0.5, 0.5));
});
