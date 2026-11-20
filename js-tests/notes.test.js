import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_NOTE, MAX_NOTES, addNote, noteAt, notesSummary } from "../src/drawing_room/static/js/notes.js";

test("a note keeps its spot and tidy text; empty notes and a full list change nothing", () => {
  const one = addNote([], [300.123, 200], "  góc này   đúng chưa? ");
  assert.deepEqual(one, [{ x: 300.1, y: 200, text: "góc này đúng chưa?" }]);
  assert.equal(addNote(one, [1, 1], "   "), one);
  assert.equal(addNote(one, [NaN, 1], "x"), one);
  assert.equal(addNote([], [0, 0], "x".repeat(500))[0].text.length, MAX_NOTE);
  let many = [];
  for (let i = 0; i < MAX_NOTES + 3; i++) many = addNote(many, [i, i], `n${i}`);
  assert.equal(many.length, MAX_NOTES);
});

test("notes read as numbered lines, and a tap finds the nearest pin", () => {
  const notes = [{ x: 0, y: 0, text: "a" }, { x: 100, y: 0, text: "b" }];
  assert.equal(notesSummary(notes), "📍1 a\n📍2 b");
  assert.equal(noteAt(notes, [96, 3], 10), 1);
  assert.equal(noteAt(notes, [50, 0], 10), -1);
});
