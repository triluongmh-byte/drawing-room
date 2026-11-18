import { test } from "node:test";
import assert from "node:assert/strict";
import { History, allStrokes, createDocument } from "../src/drawing_room/static/js/history.js";
import { MAX_LAYERS, getLayer } from "../src/drawing_room/static/js/layers.js";
import { addPoint, createStroke } from "../src/drawing_room/static/js/strokes.js";

function stroke(layer, id) {
  const s = createStroke({ layer, id });
  addPoint(s, 0, 0);
  return s;
}

const ids = (strokes) => strokes.map((s) => s.id);
const names = (history) => history.doc.layers.map((l) => l.name);

test("undo and redo of added strokes", () => {
  const history = new History();
  history.add(stroke("sketch", "a")); history.add(stroke("line", "b"));
  assert.deepEqual(ids(allStrokes(history.doc)), ["a", "b"]);
  assert.equal(history.undo(), true);
  assert.deepEqual(ids(allStrokes(history.doc)), ["a"]);
  assert.equal(history.canRedo, true);
  history.redo();
  assert.deepEqual(ids(getLayer(history.doc, "line").strokes), ["b"]);
});

test("a new stroke clears the redo stack", () => {
  const history = new History();
  history.add(stroke("sketch", "a"));
  history.undo();
  history.add(stroke("sketch", "c"));
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), false);
});

test("erasing restores strokes in their original order on undo", () => {
  const history = new History();
  const [a, b, c] = ["a", "b", "c"].map((id) => stroke("line", id));
  [a, b, c].forEach((s) => history.add(s));
  assert.equal(history.erase([c, a]), 2);
  const line = getLayer(history.doc, "line");
  assert.deepEqual(ids(line.strokes), ["b"]);
  history.undo();
  assert.deepEqual(ids(line.strokes), ["a", "b", "c"]);
  history.redo();
  assert.deepEqual(ids(line.strokes), ["b"]);
});

test("erasing nothing does not create an undo step", () => {
  const history = new History();
  assert.equal(history.erase([stroke("line", "ghost")]), 0);
  assert.equal(history.canUndo, false);
});

test("clearing everything, or one layer, is one undoable step", () => {
  const history = new History();
  history.add(stroke("sketch", "a")); history.add(stroke("color", "b"));
  history.clear(["sketch"]);
  assert.deepEqual(ids(allStrokes(history.doc)), ["b"]);
  history.clear();
  assert.equal(allStrokes(history.doc).length, 0);
  history.undo();
  assert.deepEqual(ids(allStrokes(history.doc)), ["b"]);
  history.undo();
  assert.deepEqual(ids(allStrokes(history.doc)), ["a", "b"]);
});

test("strokes need an existing layer", () => {
  const history = new History(createDocument());
  assert.throws(() => history.add(stroke("reference", "x")));
});

test("a new layer goes above the chosen one, is named, and can be undone", () => {
  const history = new History();
  const layer = history.addLayer({ name: "  Shadows " }, "sketch");
  assert.deepEqual(names(history), ["Sketch", "Shadows", "Line", "Color"]);
  history.add(stroke(layer.id, "s"));
  history.undo(); history.undo();
  assert.deepEqual(names(history), ["Sketch", "Line", "Color"]);
  history.redo(); history.redo();
  assert.deepEqual(ids(getLayer(history.doc, layer.id).strokes), ["s"]);
  const top = history.addLayer();
  assert.equal(top.name, "Layer 5");
  assert.equal(history.doc.layers.at(-1), top);
});

test("the stack stops growing at MAX_LAYERS", () => {
  const history = new History();
  while (history.doc.layers.length < MAX_LAYERS) assert.ok(history.addLayer());
  assert.equal(history.addLayer(), null);
});

test("deleting a layer takes its strokes; undo brings both back in place", () => {
  const history = new History();
  history.add(stroke("line", "a"));
  assert.equal(history.removeLayer("line"), true);
  assert.deepEqual(names(history), ["Sketch", "Color"]);
  assert.equal(allStrokes(history.doc).length, 0);
  history.undo();
  assert.deepEqual(names(history), ["Sketch", "Line", "Color"]);
  assert.deepEqual(ids(allStrokes(history.doc)), ["a"]);
  assert.equal(history.removeLayer("nope"), false);
});

test("the last layer cannot be deleted", () => {
  const history = new History();
  history.removeLayer("sketch"); history.removeLayer("line");
  assert.equal(history.removeLayer("color"), false);
  assert.equal(history.doc.layers.length, 1);
});

test("layers move up and down within the stack, undoably", () => {
  const history = new History();
  assert.equal(history.moveLayer("sketch", 1), true);
  assert.deepEqual(names(history), ["Line", "Sketch", "Color"]);
  assert.equal(history.moveLayer("color", 1), false);
  assert.equal(history.moveLayer("line", -1), false);
  history.moveLayer("sketch", 1);
  assert.deepEqual(names(history), ["Line", "Color", "Sketch"]);
  history.undo();
  history.undo();
  assert.deepEqual(names(history), ["Sketch", "Line", "Color"]);
  history.redo();
  assert.deepEqual(names(history), ["Line", "Sketch", "Color"]);
});

test("renaming is undoable; blank or unchanged names do nothing", () => {
  const history = new History();
  assert.equal(history.renameLayer("line", "Outline"), true);
  assert.equal(getLayer(history.doc, "line").name, "Outline");
  assert.equal(history.renameLayer("line", "   "), false);
  assert.equal(history.renameLayer("line", "Outline"), false);
  history.undo();
  assert.equal(getLayer(history.doc, "line").name, "Line");
});

test("history is capped", () => {
  const history = new History(createDocument(), 3);
  for (let i = 0; i < 5; i++) history.add(stroke("sketch", `s${i}`));
  let undos = 0;
  while (history.undo()) undos++;
  assert.equal(undos, 3);
  assert.equal(getLayer(history.doc, "sketch").strokes.length, 2);
});

test("Claude's strokes for one message are one undo step, and can replace what it drew before", () => {
  const history = new History(createDocument());
  const claude = history.addLayer({ name: "Claude", scored: false });
  history.addMany([stroke(claude.id, "a"), stroke(claude.id, "b")]);
  assert.deepEqual(getLayer(history.doc, claude.id).strokes.map((s) => s.id), ["a", "b"]);
  history.addMany([stroke(claude.id, "c")], { replace: claude.id });
  assert.deepEqual(getLayer(history.doc, claude.id).strokes.map((s) => s.id), ["c"]);
  history.undo();
  assert.deepEqual(getLayer(history.doc, claude.id).strokes.map((s) => s.id), ["a", "b"]);
  history.undo();
  assert.equal(getLayer(history.doc, claude.id).strokes.length, 0);
  history.redo();
  assert.equal(getLayer(history.doc, claude.id).strokes.length, 2);
});
