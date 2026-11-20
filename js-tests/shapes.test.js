import { test } from "node:test";
import assert from "node:assert/strict";
import { SHAPES, bigEnough, dashPattern, dashSegments, shapePoints, snapAngle } from "../src/drawing_room/static/js/shapes.js";

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

const length = (pts) => pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

test("a line is cut into dashes of the dash length with gaps between", () => {
  const pieces = dashSegments([[0, 0], [100, 0]], 10, 5); // 10 on, 5 off: dashes start at 0, 15, 30, ... 90
  assert.equal(pieces.length, 7);
  assert.deepEqual(pieces[0], [[0, 0], [10, 0]]);
  assert.deepEqual(pieces[1], [[15, 0], [25, 0]]);
  for (const piece of pieces.slice(0, -1)) assert.ok(close(length(piece), 10));
  assert.deepEqual(pieces.at(-1), [[90, 0], [100, 0]]);
});

test("dashes run on round corners: a dash can bend round one", () => {
  const pieces = dashSegments([[0, 0], [6, 0], [6, 20]], 10, 4);
  assert.deepEqual(pieces[0], [[0, 0], [6, 0], [6, 4]]); // 6 along, then 4 down the next side
  assert.ok(close(length(pieces[0]), 10));
  assert.deepEqual(pieces[1][0], [6, 8]);
});

test("every dash of a dashed shape has at least two points; nothing to cut gives nothing", () => {
  for (const kind of Object.keys(SHAPES)) {
    const pieces = dashSegments(shapePoints(kind, [0, 0], [180, 120]), ...dashPattern(3));
    assert.ok(pieces.length > 3, kind);
    for (const piece of pieces) assert.ok(piece.length >= 2, kind);
  }
  assert.deepEqual(dashSegments([[1, 1]], 10, 5), []);
  assert.deepEqual(dashSegments([[0, 0], [5, 0]], 0, 5), [[[0, 0], [5, 0]]]); // no dash length: solid
});

test("thicker lines get longer dashes and gaps, never shorter than 8 and 6", () => {
  assert.deepEqual(dashPattern(1), [8, 6]);
  assert.deepEqual(dashPattern(4), [16, 12]);
});
