import { test } from "node:test";
import assert from "node:assert/strict";
import { addPoint, createStroke, serializeStroke, strokeBounds, strokeHits, strokeLength, strokeStats } from "../src/drawing_room/static/js/strokes.js";

test("a stroke keeps points with pressure, time and tilt", () => {
  const stroke = createStroke({ layer: "line", tool: "ink" });
  addPoint(stroke, 0, 0, 0.3, 10, 5, -5);
  addPoint(stroke, 3, 4, 0.8, 20);
  assert.deepEqual(stroke.points, [[0, 0, 0.3, 10, 5, -5], [3, 4, 0.8, 20, 0, 0]]);
  assert.equal(strokeLength(stroke), 5);
  assert.deepEqual(strokeBounds(stroke), { x0: 0, y0: 0, x1: 3, y1: 4 });
});

test("near-duplicate points merge and bad pressure falls back to 0.5", () => {
  const stroke = createStroke({ layer: "sketch" });
  assert.equal(addPoint(stroke, 10, 10, 0), true);
  assert.equal(addPoint(stroke, 10.2, 10.1, 0.9), false);
  assert.equal(stroke.points.length, 1);
  assert.equal(stroke.points[0][2], 0.9);
  assert.equal(addPoint(stroke, NaN, 1), false);
  addPoint(stroke, 20, 10, NaN);
  assert.equal(stroke.points[1][2], 0.5);
});

test("a stroke needs a layer", () => {
  assert.throws(() => createStroke({ tool: "ink" }));
});

test("hit testing for the eraser uses the centre line plus half the stroke size", () => {
  const stroke = createStroke({ layer: "line", size: 4 });
  addPoint(stroke, 0, 0); addPoint(stroke, 100, 0);
  assert.equal(strokeHits(stroke, 50, 7.5, 6), true);
  assert.equal(strokeHits(stroke, 50, 8.5, 6), false);
  assert.equal(strokeHits(stroke, 110, 0, 6), false);
  const dot = createStroke({ layer: "line", size: 2 });
  addPoint(dot, 5, 5);
  assert.equal(strokeHits(dot, 8, 5, 3), true);
});

test("serialised strokes are rounded vectors", () => {
  const stroke = createStroke({ layer: "line", tool: "ink", id: "a" });
  addPoint(stroke, 1.234, 5.678, 0.12345, 99.6, 10.4, -3.6);
  assert.deepEqual(serializeStroke(stroke).points, [[1.2, 5.7, 0.123, 100, 10, -4]]);
  assert.equal(serializeStroke(stroke).layer, "line");
});

test("stroke stats count short scratchy strokes", () => {
  const long = createStroke({ layer: "line" }); addPoint(long, 0, 0); addPoint(long, 100, 0);
  const short = createStroke({ layer: "line" }); addPoint(short, 0, 0); addPoint(short, 10, 0);
  const stats = strokeStats([long, short, short]);
  assert.equal(stats.count, 3);
  assert.equal(stats.meanLength, 40);
  assert.equal(stats.shortShare, 2 / 3);
});

test("highlighter strokes are sent as tone (shade) so scoring and the coach skip them; marker strokes are not", () => {
  const highlight = createStroke({ layer: "color", tool: "highlighter" });
  addPoint(highlight, 1, 1);
  assert.equal(serializeStroke(highlight).shade, true);
  const marker = createStroke({ layer: "line", tool: "marker" });
  addPoint(marker, 1, 1);
  assert.equal("shade" in serializeStroke(marker), false);
});
