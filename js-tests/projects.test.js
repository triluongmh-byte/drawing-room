import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaver, hasStrokes, nextProjectName, relativeTime } from "../src/drawing_room/static/js/projects.js";

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn) => { const id = next++; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
    fire: async () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); await new Promise((r) => setTimeout(r, 0)); },
    get count() { return timers.size; },
  };
}

test("many quick changes make one save", async () => {
  const timers = fakeTimers();
  let saves = 0;
  const saver = createSaver(async () => { saves++; }, timers);
  saver.touch(); saver.touch(); saver.touch();
  assert.equal(timers.count, 1);
  assert.equal(saves, 0);
  await timers.fire();
  assert.equal(saves, 1);
  assert.equal(saver.pending, false);
});

test("flush saves now, and only when something is waiting", async () => {
  const timers = fakeTimers();
  let saves = 0;
  const saver = createSaver(async () => { saves++; }, timers);
  await saver.flush();
  assert.equal(saves, 0);
  saver.touch();
  await saver.flush();
  assert.equal(saves, 1);
  assert.equal(timers.count, 0);
});

test("a change during a save is saved again after it; saves never overlap", async () => {
  const timers = fakeTimers();
  let running = 0, most = 0, saves = 0, release;
  const saver = createSaver(async () => {
    running++; most = Math.max(most, running); saves++;
    if (saves === 1) await new Promise((r) => { release = r; });
    running--;
  }, timers);
  saver.touch();
  const first = saver.flush();
  await new Promise((r) => setTimeout(r, 0));
  saver.touch();
  const second = saver.flush();
  release();
  await first; await second;
  assert.equal(saves, 2);
  assert.equal(most, 1);
});

test("cancel drops unsaved changes", async () => {
  const timers = fakeTimers();
  let saves = 0;
  const saver = createSaver(async () => { saves++; }, timers);
  saver.touch();
  saver.cancel();
  await saver.flush();
  assert.equal(saves, 0);
});

test("a failed save stays pending so the next change retries", async () => {
  const timers = fakeTimers();
  let fail = true, saves = 0;
  const saver = createSaver(async () => { saves++; if (fail) throw new Error("offline"); }, timers);
  saver.touch();
  await assert.rejects(saver.flush());
  fail = false;
  saver.touch();
  await saver.flush();
  assert.equal(saves, 2);
});

test("relative times read naturally", () => {
  const now = 1_000_000;
  assert.equal(relativeTime(now - 5, now), "just now");
  assert.equal(relativeTime(now - 300, now), "5 min ago");
  assert.equal(relativeTime(now - 7200, now), "2 h ago");
  assert.equal(relativeTime(now - 86400, now), "1 day ago");
  assert.equal(relativeTime(now - 3 * 86400, now), "3 days ago");
  assert.match(relativeTime(now - 30 * 86400, now), /^\d{4}-\d{2}-\d{2}$/);
});

test("new project names count up and skip taken ones", () => {
  assert.equal(nextProjectName([]), "Drawing 1");
  assert.equal(nextProjectName([{ name: "Apple" }, { name: "drawing 2" }]), "Drawing 3");
});

test("old single drawings are kept only if they have strokes", () => {
  assert.equal(hasStrokes(null), false);
  assert.equal(hasStrokes({ layers: [{ strokes: [] }] }), false);
  assert.equal(hasStrokes({ layers: [{ strokes: [{}] }] }), true);
  assert.equal(hasStrokes({ layers: { sketch: [], line: [{}] } }), true);
});
