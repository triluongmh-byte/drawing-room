import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_LENGTH, createRuler, distanceToRuler, dragEnd, hitHandle, moveRuler, projectOnto, restoreRuler,
  rulerAngle, rulerCenter, rulerLength, setAngle, snapDegrees, snapsToRuler,
} from "../src/drawing_room/static/js/ruler.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("a new ruler is level, centred and the asked length", () => {
  const ruler = createRuler(500, 375, 600);
  assert.equal(rulerAngle(ruler), 0);
  close(rulerLength(ruler), 600);
  assert.deepEqual(rulerCenter(ruler).map(Math.round), [500, 375]);
});

test("angles read counter-clockwise with y pointing down, in [0, 180)", () => {
  assert.equal(rulerAngle({ a: [0, 0], b: [10, -10] }), 45);
  assert.equal(rulerAngle({ a: [0, 0], b: [0, -10] }), 90);
  assert.equal(rulerAngle({ a: [0, 0], b: [-10, 0] }), 0);
  assert.equal(rulerAngle({ a: [0, 0], b: [10, 10] }), 135);
});

test("setting an angle turns about the centre and keeps the length", () => {
  const ruler = setAngle(createRuler(500, 375, 400), 30);
  assert.equal(rulerAngle(ruler), 30);
  close(rulerLength(ruler), 400);
  assert.deepEqual(rulerCenter(ruler).map(Math.round), [500, 375]);
  assert.deepEqual(setAngle(ruler, "abc"), ruler);
});

test("angles snap to 15° steps only when close", () => {
  assert.equal(snapDegrees(43), 45);
  assert.equal(snapDegrees(-2), -0);
  assert.equal(snapDegrees(38), 38);
});

test("dragging an end turns about the other end, snapping unless told not to", () => {
  const ruler = createRuler(0, 0, 200); // a = [-100, 0]
  const at = (degrees) => [-100 + 150 * Math.cos((degrees * Math.PI) / 180), -150 * Math.sin((degrees * Math.PI) / 180)];
  const turned = dragEnd(ruler, "b", at(44));
  assert.equal(rulerAngle(turned), 45);
  close(rulerLength(turned), 150);
  assert.deepEqual(turned.a, ruler.a);
  assert.equal(rulerAngle(dragEnd(ruler, "b", at(44), { snap: false })), 44);
  assert.equal(rulerAngle(dragEnd(ruler, "b", at(38))), 38);
  const short = dragEnd(ruler, "b", [-99, 0]);
  close(rulerLength(short), MIN_LENGTH);
});

test("moving shifts both ends", () => {
  const moved = moveRuler(createRuler(0, 0, 100), 5, -3);
  assert.deepEqual(moved.a, [-45, -3]);
  assert.deepEqual(moved.b, [55, -3]);
});

test("points project onto the ruler's line", () => {
  const ruler = setAngle(createRuler(0, 0, 100), 45);
  const [x, y] = projectOnto(ruler, [10, 0]);
  close(x, 5); close(y, -5);
  const { distance, along } = distanceToRuler(createRuler(0, 0, 100), [20, 7]);
  close(distance, 7);
  assert.equal(along, true);
});

test("only strokes starting next to the ruler, along its length, follow it", () => {
  const ruler = createRuler(0, 0, 100);
  assert.equal(snapsToRuler(ruler, [10, 12], 20), true);
  assert.equal(snapsToRuler(ruler, [10, 30], 20), false);
  assert.equal(snapsToRuler(ruler, [80, 5], 20), false);
});

test("handles: the two ends and the middle", () => {
  const ruler = createRuler(0, 0, 200);
  assert.equal(hitHandle(ruler, [-98, 3], 10), "a");
  assert.equal(hitHandle(ruler, [100, 0], 10), "b");
  assert.equal(hitHandle(ruler, [2, -2], 10), "move");
  assert.equal(hitHandle(ruler, [50, 0], 10), null);
});

test("saved rulers are checked", () => {
  assert.deepEqual(restoreRuler({ a: [0, 0], b: [10, 0] }), { a: [0, 0], b: [10, 0] });
  assert.equal(restoreRuler({ a: [0, 0], b: [0, 0] }), null);
  assert.equal(restoreRuler({ a: [0, "x"], b: [1, 1] }), null);
  assert.equal(restoreRuler(null), null);
});
