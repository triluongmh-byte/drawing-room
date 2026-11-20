// The colour picker (eyedropper): read the colour of the drawing, or of the reference picture, at a point.

import { cachedPath, paintOrder, paintStroke } from "./render.js";

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function onePixel() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  return canvas.getContext("2d", { willReadFrequently: true });
}

/**
 * The drawing's own colour at paper point (x, y): the visible layers at their opacity on white paper, without the
 * reference, the score boxes or the ruler. `painted` is false where no layer has paint (the bare paper).
 */
export function drawingColorAt(layers, x, y) {
  const out = onePixel();
  out.fillStyle = "#ffffff";
  out.fillRect(0, 0, 1, 1);
  const layerCtx = onePixel();
  let painted = false;
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0 || !layer.strokes.length) continue;
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.clearRect(0, 0, 1, 1);
    // The pixel's centre sits on the point.
    layerCtx.setTransform(1, 0, 0, 1, 0.5 - x, 0.5 - y);
    for (const stroke of paintOrder(layer.strokes)) paintStroke(layerCtx, stroke, cachedPath(stroke));
    if (layerCtx.getImageData(0, 0, 1, 1).data[3] > 0) painted = true;
    out.globalAlpha = layer.opacity;
    out.drawImage(layerCtx.canvas, 0, 0);
    out.globalAlpha = 1;
  }
  return { color: toHex(out.getImageData(0, 0, 1, 1).data), painted };
}

/** An image's colour at (u, v) in its own pixels, on white where it is transparent, or null outside it. */
export function imageColorAt(image, u, v) {
  if (!image?.complete || !image.naturalWidth) return null;
  if (u < 0 || v < 0 || u >= image.naturalWidth || v >= image.naturalHeight) return null;
  const out = onePixel();
  out.fillStyle = "#ffffff";
  out.fillRect(0, 0, 1, 1);
  out.drawImage(image, Math.floor(u), Math.floor(v), 1, 1, 0, 0, 1, 1);
  return toHex(out.getImageData(0, 0, 1, 1).data);
}
