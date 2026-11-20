// Stroke model: a stroke is a list of points [x, y, pressure, t, tiltX, tiltY] in paper pixels,
// plus how it should look. Pure functions, no DOM, so they can be tested with `node --test`.

export const MIN_POINT_DISTANCE = 0.75;

import { paintedSize } from "./pencil.js";

let nextId = 1;

export function createStroke({ layer, tool, color = "#111111", size = 4, opacity = 1, simulatePressure = false, id } = {}) {
  if (!layer) throw new Error("a stroke needs a layer");
  return { id: id ?? `s${Date.now().toString(36)}${(nextId++).toString(36)}`, layer, tool, color, size, opacity,
           simulatePressure, points: [] };
}

function clampPressure(pressure) {
  if (!Number.isFinite(pressure) || pressure <= 0) return 0.5;
  return Math.min(1, pressure);
}

/** Append a point; points closer than MIN_POINT_DISTANCE to the last one are merged (pressure kept). */
export function addPoint(stroke, x, y, pressure = 0.5, t = 0, tiltX = 0, tiltY = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const point = [x, y, clampPressure(pressure), t, tiltX || 0, tiltY || 0];
  const last = stroke.points[stroke.points.length - 1];
  if (last && Math.hypot(x - last[0], y - last[1]) < MIN_POINT_DISTANCE) {
    last[2] = Math.max(last[2], point[2]);
    return false;
  }
  stroke.points.push(point);
  return true;
}

export function strokeLength(stroke) {
  let total = 0;
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1], b = stroke.points[i];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

export function strokeBounds(stroke) {
  if (!stroke.points.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of stroke.points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a circle of `radius` at (x, y) touches the stroke's centre line (widened by half its painted width). */
export function strokeHits(stroke, x, y, radius) {
  const reach = radius + paintedSize(stroke) / 2;
  const box = strokeBounds(stroke);
  if (!box || x < box.x0 - reach || x > box.x1 + reach || y < box.y0 - reach || y > box.y1 + reach) return false;
  const pts = stroke.points;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distanceToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true;
  }
  return false;
}

/** Rounded copy for the API: keeps the vectors (for replay and analysis) small on the wire. */
export function serializeStroke(stroke) {
  const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
  return {
    id: stroke.id, layer: stroke.layer, tool: stroke.tool, color: stroke.color, size: stroke.size,
    // Shading and highlighting are tone, not line: scoring and the coach leave them out.
    ...(stroke.shade || stroke.tool === "highlighter" ? { shade: true } : {}),
    points: stroke.points.map(([x, y, p, t, tx, ty]) => [round(x, 1), round(y, 1), round(p, 3), Math.round(t), Math.round(tx), Math.round(ty)]),
  };
}

export function strokeStats(strokes, shortLength = 25) {
  const lengths = strokes.map(strokeLength);
  const count = lengths.length;
  return {
    count,
    meanLength: count ? lengths.reduce((a, b) => a + b, 0) / count : 0,
    shortShare: count ? lengths.filter((value) => value < shortLength).length / count : 0,
  };
}
