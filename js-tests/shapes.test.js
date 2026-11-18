import { test } from "node:test";
import assert from "node:assert/strict";

import { shapeKind, shapePoints } from "../src/drawing_room/static/js/shapes.js";

const near = (a, b) => Math.abs(a - b) < 1e-6;

test("a rectangle keeps its four corners and closes", () => {
  const points = shapePoints("rect", [10, 20], [110, 80]);
  for (const corner of [[10, 20], [110, 20], [110, 80], [10, 80]]) {
    assert.ok(points.some(([x, y]) => near(x, corner[0]) && near(y, corner[1])), `corner ${corner}`);
  }
  assert.deepEqual(points[0], points.at(-1));
});

test("Shift makes a square and a circle, in the direction of the drag", () => {
  const square = shapePoints("rect", [100, 100], [40, 130], { even: true });
  const xs = square.map((p) => p[0]), ys = square.map((p) => p[1]);
  assert.equal(Math.max(...xs) - Math.min(...xs), 60);
  assert.equal(Math.max(...ys) - Math.min(...ys), 60);
  assert.equal(Math.min(...xs), 40, "goes left like the drag");
  const circle = shapePoints("ellipse", [0, 0], [100, 40], { even: true });
  for (const [x, y] of circle) assert.ok(Math.abs(Math.hypot(x - 50, y - 50) - 50) < 1e-6);
});

test("Shift snaps a line to 15° steps", () => {
  const line = shapePoints("line", [0, 0], [100, 20], { even: true });
  const [x, y] = line.at(-1);
  assert.ok(near(Math.atan2(y, x), Math.PI / 12));
});

test("a triangle has its apex in the middle of the top", () => {
  const points = shapePoints("triangle", [0, 0], [100, 80]);
  assert.deepEqual(points[0], [50, 0]);
  assert.ok(points.some(([px, py]) => near(px, 100) && near(py, 80)));
});

test("unknown kinds fall back to the rectangle", () => {
  assert.equal(shapeKind("star"), "rect");
  assert.equal(shapeKind("ellipse"), "ellipse");
});
