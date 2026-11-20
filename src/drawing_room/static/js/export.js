// Save the drawing as a PNG or JPG: the sheet plus anything drawn past it, on white paper, every visible layer at its own opacity, without
// the reference underlay, the score boxes or the ruler. Drawn at EXPORT_SCALE pixels per paper unit.

import { cachedPath, paintOrder, paintStroke } from "./render.js";

export const EXPORT_SCALE = 2;
export const FORMATS = { png: { type: "image/png", ext: "png" }, jpg: { type: "image/jpeg", ext: "jpg", quality: 0.92 } };

/** A safe file name from the project name: letters (any language), digits, spaces, dashes and underscores. */
export function exportFileName(name, format) {
  const base = String(name ?? "").normalize("NFC").replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${base || "drawing"}.${FORMATS[format].ext}`;
}

/** The sheet in pixels, rounded, at `scale` pixels per paper unit. */
export function exportSize(sheet, scale = EXPORT_SCALE) {
  const [x0, y0, x1, y1] = sheet;
  return [Math.max(1, Math.round((x1 - x0) * scale)), Math.max(1, Math.round((y1 - y0) * scale))];
}

/** Draw the layers onto a new canvas the size of the sheet. */
export function renderSheet(layers, sheet, scale = EXPORT_SCALE) {
  const [w, h] = exportSize(sheet, scale);
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const layerCanvas = document.createElement("canvas");
  layerCanvas.width = w; layerCanvas.height = h;
  const layerCtx = layerCanvas.getContext("2d");
  const transform = [scale, 0, 0, scale, -sheet[0] * scale, -sheet[1] * scale];
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0 || !layer.strokes.length) continue;
    // Each layer is painted on its own canvas first, so its opacity applies to the layer as a whole, as on screen.
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.clearRect(0, 0, w, h);
    layerCtx.setTransform(...transform);
    for (const stroke of paintOrder(layer.strokes)) paintStroke(layerCtx, stroke, cachedPath(stroke));
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layerCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }
  return out;
}

/** Render the sheet and hand it to the browser as a download. */
export function downloadSheet(layers, sheet, name, format) {
  const { type, quality } = FORMATS[format];
  const out = renderSheet(layers, sheet);
  return new Promise((resolve, reject) => {
    out.toBlob((blob) => {
      if (!blob) { reject(new Error("The browser could not make the image.")); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName(name, format);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      resolve(link.download);
    }, type, quality);
  });
}
