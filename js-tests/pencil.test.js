import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TILT_SHADE_WIDTH, altitudeFromTilt, flatness, isShading, paintedSize, pencilOpacity, settlePencil, strokeFlatness,
} from "../src/drawing_room/static/js/pencil.js";
import { createStroke, addPoint, serializeStroke, strokeHits } from "../src/drawing_room/static/js/strokes.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function pencilStroke({ tool = "pencil", pressure = 0.5, tilt = 0, simulatePressure = false } = {}) {
  const stroke = createStroke({ layer: "sketch", tool, size: 3, simulatePressure });
  for (let x = 0; x <= 100; x += 10) addPoint(stroke, x, 0, pressure, x, tilt, 0);
  return stroke;
}

test("altitude comes from tilt: upright is 90°, leaning one way by 30° is 60°", () => {
  close(altitudeFromTilt(0, 0), 90);
  close(altitudeFromTilt(30, 0), 60);
  close(altitudeFromTilt(0, -30), 60);
  assert.ok(altitudeFromTilt(45, 45) < 45);
  assert.ok(altitudeFromTilt(90, 0) > 0);
});

test("flatness is 0 held upright, 1 on its side, smooth in between", () => {
  assert.equal(flatness(90), 0);
  assert.equal(flatness(60), 0);
  assert.equal(flatness(25), 1);
  assert.equal(flatness(10), 1);
  const mid = flatness(42.5);
  close(mid, 0.5);
});

test("a pen laid on its side shades; held upright it draws a line", () => {
  assert.equal(isShading(pencilStroke({ tilt: 0 })), false);
  assert.equal(isShading(pencilStroke({ tilt: 70 })), true);
  assert.ok(strokeFlatness(pencilStroke({ tilt: 70 }).points) > 0.9);
  // A mouse reports no tilt, so only the Shade tool shades.
  assert.equal(isShading(pencilStroke({ tilt: 70, simulatePressure: true })), false);
  assert.equal(isShading(pencilStroke({ tool: "shade" })), true);
  assert.equal(isShading(pencilStroke({ tool: "ink", tilt: 70 })), false);
});

test("pressing harder makes the pencil darker; shading stays light", () => {
  const light = pencilOpacity(pencilStroke({ pressure: 0.1 }));
  const firm = pencilOpacity(pencilStroke({ pressure: 0.9 }));
  assert.ok(light < 0.45 && firm > 0.85, `${light} ${firm}`);
  const shade = settlePencil(pencilStroke({ tool: "shade", pressure: 0.9 }));
  assert.ok(shade.opacity < 0.45);
  assert.equal(pencilOpacity(pencilStroke({ simulatePressure: true, pressure: 0.1 })), pencilOpacity(pencilStroke({ simulatePressure: true, pressure: 0.9 })));
});

test("tilted shading is painted wide, and the eraser reaches its whole width", () => {
  const shade = settlePencil(pencilStroke({ tilt: 70 }));
  assert.equal(shade.shade, true);
  assert.equal(paintedSize(shade), 3 * TILT_SHADE_WIDTH);
  assert.equal(strokeHits(shade, 50, 8, 0), true);
  const line = settlePencil(pencilStroke());
  assert.equal(paintedSize(line), 3);
  assert.equal(strokeHits(line, 50, 8, 0), false);
});

test("settling leaves other tools alone; shading is marked on the wire", () => {
  const ink = createStroke({ layer: "line", tool: "ink", opacity: 1 });
  assert.equal(settlePencil(ink).shade, undefined);
  assert.equal(serializeStroke(settlePencil(pencilStroke({ tilt: 70 }))).shade, true);
  assert.equal("shade" in serializeStroke(settlePencil(pencilStroke())), false);
});
