import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NAME, canDraw, cleanName, createDocument, createLayer, createReferenceState, getLayer, nextLayerName,
  referenceVisible, restoreDocument, serializeDocument, setLayerOpacity, setReferenceOpacity, strokesForScoring,
} from "../src/drawing_room/static/js/layers.js";

test("a new drawing has Sketch, Line and Color, bottom to top; Color is not scored", () => {
  const doc = createDocument();
  assert.deepEqual(doc.layers.map((l) => l.name), ["Sketch", "Line", "Color"]);
  assert.deepEqual(doc.layers.map((l) => l.scored), [true, true, false]);
  assert.equal(getLayer(doc, "line").name, "Line");
  assert.equal(getLayer(doc, "nope"), null);
});

test("layer names are trimmed, single-line and capped", () => {
  assert.equal(cleanName("  Shading \n pass  "), "Shading pass");
  assert.equal(cleanName("   ", "Layer 4"), "Layer 4");
  assert.equal(cleanName("x".repeat(100)).length, MAX_NAME);
  assert.equal(createLayer({ name: "" }).name, "Layer");
});

test("new layer names count up and skip names already taken", () => {
  const doc = createDocument();
  assert.equal(nextLayerName(doc), "Layer 4");
  doc.layers.push(createLayer({ name: "Layer 4" }));
  assert.equal(nextLayerName(doc), "Layer 5");
});

test("only visible, unlocked layers take strokes", () => {
  const layer = createLayer();
  assert.equal(canDraw(layer), true);
  layer.locked = true;
  assert.equal(canDraw(layer), false);
  layer.locked = false; layer.visible = false;
  assert.equal(canDraw(layer), false);
  assert.equal(canDraw(null), false);
});

test("layer and reference opacity are clamped", () => {
  const layer = createLayer();
  assert.equal(setLayerOpacity(layer, 3).opacity, 1);
  assert.equal(setLayerOpacity(layer, "0.25").opacity, 0.25);
  assert.equal(setLayerOpacity(layer, "x").opacity, 0.25);
  const reference = createReferenceState();
  assert.equal(setReferenceOpacity(reference, -1).opacity, 0);
});

test("a locked reference stays hidden", () => {
  const reference = createReferenceState();
  assert.equal(referenceVisible(reference), true);
  reference.locked = true;
  assert.equal(referenceVisible(reference), false);
});

test("scoring gets visible layers only, tagged with whether each is scored", () => {
  const doc = createDocument();
  getLayer(doc, "sketch").strokes.push({ id: "a", points: [[0, 0]] });
  getLayer(doc, "color").strokes.push({ id: "b", points: [[0, 0]] });
  getLayer(doc, "line").strokes.push({ id: "c", points: [[0, 0]] });
  getLayer(doc, "line").visible = false;
  const strokes = strokesForScoring(doc);
  assert.deepEqual(strokes.map((s) => [s.id, s.scored]), [["a", true], ["b", false]]);
});

test("documents round-trip through saving", () => {
  const doc = createDocument();
  doc.layers.push(createLayer({ id: "l1", name: "Shadows", opacity: 0.5, locked: true, scored: false }));
  doc.layers[3].strokes.push({ id: "s", layer: "l1", points: [[1, 2]] });
  const restored = restoreDocument(JSON.parse(JSON.stringify(serializeDocument(doc))));
  assert.deepEqual(restored.layers.map((l) => [l.id, l.name, l.opacity, l.locked, l.scored]),
    [["sketch", "Sketch", 1, false, true], ["line", "Line", 1, false, true], ["color", "Color", 1, false, false], ["l1", "Shadows", 0.5, true, false]]);
  assert.equal(restored.layers[3].strokes[0].id, "s");
});

test("v0 saves (fixed layers keyed by id) are upgraded", () => {
  const restored = restoreDocument({ layers: { sketch: [{ id: "a", layer: "sketch", points: [[0, 0]] }], line: "junk", color: [null] } });
  assert.deepEqual(restored.layers.map((l) => l.strokes.length), [1, 0, 0]);
  assert.equal(restored.layers[0].strokes[0].layer, "sketch");
});

test("unreadable saves give a fresh drawing; duplicate layer ids are dropped", () => {
  assert.equal(restoreDocument(null).layers.length, 3);
  assert.equal(restoreDocument({ layers: [] }).layers.length, 3);
  const doc = restoreDocument({ layers: [{ id: "x", name: "A" }, { id: "x", name: "B" }, { name: "no id" }] });
  assert.deepEqual(doc.layers.map((l) => l.name), ["A"]);
});
