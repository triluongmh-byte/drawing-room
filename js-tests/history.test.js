import { test } from "node:test";
import assert from "node:assert/strict";
import { History, allStrokes, createDocument } from "../src/drawing_room/static/js/history.js";
import { addPoint, createStroke } from "../src/drawing_room/static/js/strokes.js";

function stroke(layer, id) {
  const s = createStroke({ layer, id });
  addPoint(s, 0, 0);
  return s;
}

test("undo and redo of added strokes", () => {
  const history = new History();
  const a = stroke("sketch", "a"), b = stroke("line", "b");
  history.add(a); history.add(b);
  assert.deepEqual(allStrokes(history.doc).map((s) => s.id), ["a", "b"]);
  assert.equal(history.undo(), true);
  assert.deepEqual(allStrokes(history.doc).map((s) => s.id), ["a"]);
  assert.equal(history.canRedo, true);
  history.redo();
  assert.deepEqual(history.doc.layers.line.map((s) => s.id), ["b"]);
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
  assert.deepEqual(history.doc.layers.line.map((s) => s.id), ["b"]);
  history.undo();
  assert.deepEqual(history.doc.layers.line.map((s) => s.id), ["a", "b", "c"]);
  history.redo();
  assert.deepEqual(history.doc.layers.line.map((s) => s.id), ["b"]);
});

test("erasing nothing does not create an undo step", () => {
  const history = new History();
  assert.equal(history.erase([stroke("line", "ghost")]), 0);
  assert.equal(history.canUndo, false);
});

test("clear is one undoable step", () => {
  const history = new History();
  history.add(stroke("sketch", "a")); history.add(stroke("color", "b"));
  history.clear();
  assert.equal(allStrokes(history.doc).length, 0);
  history.undo();
  assert.deepEqual(allStrokes(history.doc).map((s) => s.id), ["a", "b"]);
});

test("strokes cannot go on the reference layer", () => {
  const history = new History(createDocument());
  assert.throws(() => history.add(stroke("reference", "x")));
});

test("history is capped", () => {
  const history = new History(createDocument(), 3);
  for (let i = 0; i < 5; i++) history.add(stroke("sketch", `s${i}`));
  let undos = 0;
  while (history.undo()) undos++;
  assert.equal(undos, 3);
  assert.equal(history.doc.layers.sketch.length, 2);
});
