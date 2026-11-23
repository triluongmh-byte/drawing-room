import { test } from "node:test";
import assert from "node:assert/strict";

import { exportFileName, exportSize } from "../src/drawing_room/static/js/export.js";

test("export file names keep letters in any language and drop path characters", () => {
  assert.equal(exportFileName("Apple study", "png"), "Apple study.png");
  assert.equal(exportFileName("Vẽ hộp / phối cảnh", "jpg"), "Vẽ hộp phối cảnh.jpg");
  assert.equal(exportFileName("../../etc", "png"), "etc.png");
  assert.equal(exportFileName("", "jpg"), "drawing.jpg");
  assert.equal(exportFileName(null, "png"), "drawing.png");
});

test("the export covers the sheet at 2 pixels per paper unit", () => {
  assert.deepEqual(exportSize([0, 0, 1000, 750]), [2000, 1500]);
  assert.deepEqual(exportSize([0, -332.1, 1000, 1082.1]), [2000, 2828]);
});
