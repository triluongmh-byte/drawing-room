import { test } from "node:test";
import assert from "node:assert/strict";
import { COLORED, GROUPS, TOOLS, clampSize, groupOf, restoreToolSettings, shareColor, stepSize } from "../src/drawing_room/static/js/tools.js";

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

test("a picked colour is shared within the tool's group only, the eraser keeps none", () => {
  const settings = shareColor(restoreToolSettings(), "#2F6FD0", "ink");
  for (const tool of ["pencil", "ink", "marker"]) assert.equal(settings[tool].color, "#2f6fd0");
  // The paint tools keep their own: the highlighter stays yellow when the pencil turns blue.
  assert.equal(settings.highlighter.color, TOOLS.highlighter.color);
  assert.equal(settings.brush.color, TOOLS.brush.color);
  shareColor(settings, "#123456", "highlighter");
  for (const tool of ["brush", "shade", "highlighter"]) assert.equal(settings[tool].color, "#123456");
  assert.equal(settings.pencil.color, "#2f6fd0");
  assert.equal(settings.eraser.color, undefined);
  assert.equal(shareColor(settings, "red", "pencil").pencil.color, "#2f6fd0"); // not a colour: ignored
  assert.equal(shareColor(settings, "#ffffff", "eraser").pencil.color, "#2f6fd0"); // no group: ignored
});

test("tools sit in two groups, each with six colours to pick from; the eraser in neither", () => {
  assert.deepEqual(GROUPS.write.tools, ["pencil", "ink", "marker"]);
  assert.deepEqual(GROUPS.paint.tools, ["brush", "shade", "highlighter"]);
  for (const group of Object.values(GROUPS)) {
    assert.equal(group.palette.length, 6);
    for (const color of group.palette) assert.match(color, /^#[0-9a-f]{6}$/);
  }
  assert.equal(groupOf("marker"), "write");
  assert.equal(groupOf("shade"), "paint");
  assert.equal(groupOf("eraser"), null);
  assert.deepEqual([...COLORED].sort(), Object.keys(TOOLS).filter((t) => t !== "eraser").sort());
});

test("the marker is even-width and opaque, the highlighter wide, see-through and multiplied", () => {
  assert.equal(TOOLS.marker.thinning, 0);
  assert.ok(TOOLS.marker.opacity > 0.8);
  assert.equal(TOOLS.highlighter.blend, "multiply");
  assert.ok(TOOLS.highlighter.opacity < 0.5);
  assert.ok(TOOLS.highlighter.size > TOOLS.marker.size);
});
