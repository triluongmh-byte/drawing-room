import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, clampSize, restoreToolSettings, stepSize } from "../src/drawing_room/static/js/tools.js";

test("every tool starts at its default size; colours only where a tool has one", () => {
  const settings = restoreToolSettings();
  assert.equal(settings.pencil.size, TOOLS.pencil.size);
  assert.equal(settings.brush.color, TOOLS.brush.color);
  assert.equal(settings.eraser.color, undefined);
  assert.ok(TOOLS.shade.size > TOOLS.pencil.size);
});

test("saved settings are checked: sizes clamped, bad colours dropped", () => {
  const settings = restoreToolSettings({ pencil: { size: 99, color: "#ABCDEF" }, ink: { size: "x", color: "red" }, shade: null });
  assert.equal(settings.pencil.size, TOOLS.pencil.max);
  assert.equal(settings.pencil.color, "#abcdef");
  assert.equal(settings.ink.size, TOOLS.ink.size);
  assert.equal(settings.ink.color, TOOLS.ink.color);
  assert.equal(settings.shade.size, TOOLS.shade.size);
  assert.equal(restoreToolSettings(null).eraser.size, TOOLS.eraser.size);
});

test("sizes round to half pixels and step by about a tenth of the range", () => {
  assert.equal(clampSize("pencil", 2.3), 2.5);
  assert.equal(clampSize("pencil", 0), TOOLS.pencil.min);
  assert.equal(stepSize("pencil", 3, 1), 4);
  assert.equal(stepSize("shade", 26, -1), 20);
  assert.equal(stepSize("pencil", 12, 1), 12);
});
