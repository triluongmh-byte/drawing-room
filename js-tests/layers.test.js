import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYERS, createLayerState, isVisible, layerForTool, paintOrder, setActive, setReferenceOpacity, toggleVisible } from "../src/drawing_room/static/js/layers.js";

test("layers are fixed, bottom to top", () => {
  assert.deepEqual(LAYERS.map((l) => l.id), ["reference", "sketch", "line", "color"]);
});

test("visibility toggles per layer and paint order follows", () => {
  const state = createLayerState();
  assert.deepEqual(paintOrder(state), ["reference", "sketch", "line", "color"]);
  toggleVisible(state, "sketch");
  assert.equal(isVisible(state, "sketch"), false);
  assert.deepEqual(paintOrder(state), ["reference", "line", "color"]);
  toggleVisible(state, "sketch");
  assert.equal(isVisible(state, "sketch"), true);
  assert.throws(() => toggleVisible(state, "nope"));
});

test("a locked reference stays hidden", () => {
  const state = createLayerState();
  state.referenceLocked = true;
  assert.equal(isVisible(state, "reference"), false);
  toggleVisible(state, "reference");
  assert.equal(state.visible.reference, true);
  assert.equal(paintOrder(state)[0], "sketch");
});

test("tools pick their layer; the eraser keeps the active one", () => {
  const state = createLayerState();
  assert.equal(layerForTool(state, "pencil"), "sketch");
  assert.equal(layerForTool(state, "ink"), "line");
  assert.equal(layerForTool(state, "brush"), "color");
  setActive(state, "line");
  assert.equal(layerForTool(state, "eraser"), "line");
  assert.throws(() => setActive(state, "reference"));
});

test("reference opacity is clamped", () => {
  const state = createLayerState();
  assert.equal(setReferenceOpacity(state, 2).referenceOpacity, 1);
  assert.equal(setReferenceOpacity(state, -1).referenceOpacity, 0);
  assert.equal(setReferenceOpacity(state, "x").referenceOpacity, 0);
  assert.equal(setReferenceOpacity(state, "0.4").referenceOpacity, 0.4);
});
