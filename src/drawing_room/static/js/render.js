// Turning stroke vectors into pressure-shaped outlines with perfect-freehand, cached per stroke.

import { getStroke } from "../vendor/perfect-freehand.js";

export const TOOLS = {
  pencil: { label: "Pencil", color: "#4a4744", size: 3, opacity: 0.85, thinning: 0.55, smoothing: 0.5, streamline: 0.35 },
  ink: { label: "Ink", color: "#141312", size: 4.5, opacity: 1, thinning: 0.6, smoothing: 0.6, streamline: 0.45 },
  brush: { label: "Color", color: "#e0604a", size: 22, opacity: 0.45, thinning: 0.25, smoothing: 0.6, streamline: 0.5 },
  eraser: { label: "Eraser", radius: 12 },
};

function outlineToPath(outline) {
  const path = new Path2D();
  if (!outline.length) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length - 1; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[i + 1];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function strokePath(stroke, { last = false } = {}) {
  const tool = TOOLS[stroke.tool] || TOOLS.ink;
  const outline = getStroke(stroke.points.map(([x, y, p]) => [x, y, p]), {
    size: stroke.size,
    thinning: tool.thinning ?? 0.5,
    smoothing: tool.smoothing ?? 0.5,
    streamline: tool.streamline ?? 0.5,
    simulatePressure: stroke.simulatePressure,
    last,
  });
  return outlineToPath(outline);
}

const cache = new WeakMap();

/** A finished stroke's Path2D, computed once. */
export function cachedPath(stroke) {
  let entry = cache.get(stroke);
  if (!entry || entry.count !== stroke.points.length) {
    entry = { count: stroke.points.length, path: strokePath(stroke, { last: true }) };
    cache.set(stroke, entry);
  }
  return entry.path;
}

export function paintStroke(ctx, stroke, path) {
  ctx.globalAlpha = stroke.opacity ?? 1;
  ctx.fillStyle = stroke.color;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}
