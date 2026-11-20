import { test } from "node:test";
import assert from "node:assert/strict";
import { SHAPES, bigEnough, shapePoints, snapAngle } from "../src/drawing_room/static/js/shapes.js";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const bounds = (pts) => ({
  x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
  y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])),
});

test("six shapes, each with a label and an icon", () => {
  assert.deepEqual(Object.keys(SHAPES), ["line", "rect", "ellipse", "triangle", "diamond", "arrow"]);
  for (const shape of Object.values(SHAPES)) assert.ok(shape.label && shape.icon);
});

test("a line runs from the start of the drag to the pointer, with points along it", () => {
  const pts = shapePoints("line", [0, 0], [100, 0]);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts.at(-1), [100, 0]);
  assert.ok(pts.length > 5);
  assert.ok(pts.every(([, y]) => y === 0));
});

test("Shift turns a line to the nearest 15° and keeps its length", () => {
  const [x, y] = snapAngle([0, 0], [100, 3]);
  assert.ok(close(x, Math.hypot(100, 3)) && close(y, 0, 1e-9));
  const end = shapePoints("line", [0, 0], [100, 95], { constrain: true }).at(-1);
  assert.ok(close(Math.atan2(end[1], end[0]), Math.PI / 4, 1e-9));
});

test("a rectangle is closed and fills the dragged box whichever way it was dragged", () => {
  const pts = shapePoints("rect", [200, 150], [100, 100]);
  assert.deepEqual(pts[0], pts.at(-1));
  assert.deepEqual(bounds(pts), { x0: 100, x1: 200, y0: 100, y1: 150 });
});

test("Shift makes a square and a circle, toward the pointer", () => {
  const square = bounds(shapePoints("rect", [0, 0], [-80, 30], { constrain: true }));
  assert.deepEqual(square, { x0: -80, x1: 0, y0: 0, y1: 80 });
  const circle = bounds(shapePoints("ellipse", [0, 0], [50, 20], { constrain: true }));
  assert.ok(close(circle.x1 - circle.x0, 50, 1e-6) && close(circle.y1 - circle.y0, 50, 1e-6));
});

test("an ellipse touches its box and closes", () => {
  const pts = shapePoints("ellipse", [0, 0], [200, 100]);
  const box = bounds(pts);
  assert.ok(close(box.x0, 0) && close(box.x1, 200) && close(box.y0, 0) && close(box.y1, 100));
  assert.ok(close(pts[0][0], pts.at(-1)[0]) && close(pts[0][1], pts.at(-1)[1]));
});

test("triangle and diamond are closed and sit in the box", () => {
  for (const kind of ["triangle", "diamond"]) {
    const pts = shapePoints(kind, [0, 0], [120, 90]);
    assert.deepEqual(pts[0], pts.at(-1));
    assert.deepEqual(bounds(pts), { x0: 0, x1: 120, y0: 0, y1: 90 });
  }
  assert.deepEqual(shapePoints("triangle", [0, 0], [120, 90])[0], [60, 0]); // apex up, in the middle
});

test("an arrow is one stroke: shaft to the tip, then both wings back from it", () => {
  const pts = shapePoints("arrow", [0, 0], [200, 0]);
  assert.deepEqual(pts[0], [0, 0]);
  const tips = pts.filter(([x, y]) => x === 200 && y === 0).length;
  assert.ok(tips >= 2, "it goes back through the tip between the wings");
  const wings = pts.filter(([x]) => x < 200 && x > 150);
  assert.ok(wings.some(([, y]) => y > 5) && wings.some(([, y]) => y < -5), "one wing each side");
});

test("a tap is not a shape", () => {
  assert.equal(bigEnough([10, 10], [11, 12]), false);
  assert.equal(bigEnough([10, 10], [10, 20]), true);
});
