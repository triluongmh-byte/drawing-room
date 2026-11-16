import { test } from "node:test";
import assert from "node:assert/strict";
import { createView, fitView, gestureView, paperToScreen, rotateAt, screenToPaper, zoomAt } from "../src/drawing_room/static/js/view.js";
import { classifyPointer, createInputState } from "../src/drawing_room/static/js/input.js";

const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${a} != ${b}`));

test("screen and paper coordinates round-trip under zoom and rotation", () => {
  const view = { x: 40, y: -20, scale: 2.5, rotation: 0.7 };
  close(screenToPaper(view, ...paperToScreen(view, 123, 456)), [123, 456]);
});

test("zoom and rotate keep the point under the cursor fixed", () => {
  const view = fitView(1000, 750, 1200, 900);
  const before = screenToPaper(view, 300, 200);
  close(screenToPaper(zoomAt(view, 300, 200, 1.7), 300, 200), before);
  close(screenToPaper(rotateAt(view, 300, 200, 0.4), 300, 200), before);
});

test("fit centres the paper", () => {
  const view = fitView(1000, 750, 1048, 798, 24);
  assert.equal(view.scale, 1);
  close(paperToScreen(view, 500, 375), [524, 399]);
});

test("a two-finger gesture keeps paper points under the fingers", () => {
  const start = createView();
  const a0 = [100, 100], b0 = [200, 100];
  const pa = screenToPaper(start, ...a0), pb = screenToPaper(start, ...b0);
  const a1 = [50, 80], b1 = [50, 280]; // moved, spread to double distance, turned 90 degrees
  const view = gestureView(start, a0, b0, a1, b1);
  close(paperToScreen(view, ...pa), a1);
  close(paperToScreen(view, ...pb), b1);
  assert.ok(Math.abs(view.scale - 2) < 1e-9);
});

test("palm rejection: after a pen, touches only gesture", () => {
  const state = createInputState();
  assert.equal(classifyPointer(state, { pointerType: "touch" }), "draw");
  assert.equal(classifyPointer(state, { pointerType: "pen" }), "draw");
  assert.equal(state.penSeen, true);
  assert.equal(classifyPointer(state, { pointerType: "touch" }), "gesture");
});

test("a second finger is a gesture and space turns the mouse into a pan", () => {
  const state = createInputState();
  state.touches = 1;
  assert.equal(classifyPointer(state, { pointerType: "touch" }), "gesture");
  assert.equal(classifyPointer(state, { pointerType: "mouse", button: 0 }), "draw");
  assert.equal(classifyPointer(state, { pointerType: "mouse", button: 2 }), "ignore");
  assert.equal(classifyPointer(state, { pointerType: "mouse", button: 1 }), "pan");
  state.spaceDown = true;
  assert.equal(classifyPointer(state, { pointerType: "mouse", button: 0 }), "pan");
});
