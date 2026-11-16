// How a graphite pencil behaves: pressing harder makes the line both wider and darker, and laying the
// pencil low on its side gives a broad, light, grainy band for shading. Pen tilt comes from Pointer
// Events (tiltX/tiltY, degrees); a mouse or trackpad has none, so the Shade tool lays the pencil flat.
// Pure functions, no DOM, so they can be tested with `node --test`.

/** Below FLAT_FROM degrees of altitude the pencil starts to lie on its side; at FLAT_AT it is fully flat. */
export const FLAT_FROM = 60;
export const FLAT_AT = 25;
/** A pencil held this flat for most of a stroke turns it into shading. */
export const SHADE_THRESHOLD = 0.5;
/** Shading from a tilted pencil is this many times wider than the pencil's line. */
export const TILT_SHADE_WIDTH = 6;

/** The pen's altitude above the paper in degrees (90 is upright) from its tilt angles. */
export function altitudeFromTilt(tiltX = 0, tiltY = 0) {
  const clampTilt = (deg) => (Math.max(-89, Math.min(89, Number(deg) || 0)) * Math.PI) / 180;
  const lean = Math.hypot(Math.tan(clampTilt(tiltX)), Math.tan(clampTilt(tiltY)));
  return 90 - (Math.atan(lean) * 180) / Math.PI;
}

/** How flat the pencil lies: 0 upright (a line), 1 on its side (shading), smooth in between. */
export function flatness(altitude) {
  const t = Math.min(1, Math.max(0, (FLAT_FROM - altitude) / (FLAT_FROM - FLAT_AT)));
  return t * t * (3 - 2 * t);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The typical flatness over a stroke's points ([x, y, pressure, t, tiltX, tiltY]). */
export function strokeFlatness(points) {
  return median(points.map((p) => flatness(altitudeFromTilt(p[4], p[5]))));
}

/** The typical pressure over a stroke's points, or 0.5 when the device reports none. */
export function strokePressure(points) {
  return points.length ? median(points.map((p) => p[2])) : 0.5;
}

/** Whether a stroke is shading (made with the Shade tool, or a pen held on its side) rather than a line. */
export function isShading(stroke) {
  if (stroke.tool === "shade") return true;
  return stroke.tool === "pencil" && !stroke.simulatePressure && strokeFlatness(stroke.points) >= SHADE_THRESHOLD;
}

/** The width the stroke is painted at, in paper pixels. */
export function paintedSize(stroke) {
  if (stroke.tool === "pencil" && stroke.shade) return stroke.size * TILT_SHADE_WIDTH;
  return stroke.size;
}

/**
 * How dark a pencil stroke is painted. Graphite builds up: a light touch leaves a pale line, a firm one
 * a dark line, and shading stays light so it can be layered. Without real pressure, a middle value.
 */
export function pencilOpacity(stroke) {
  const pressure = stroke.simulatePressure ? 0.55 : strokePressure(stroke.points);
  if (stroke.shade || stroke.tool === "shade") return round2(0.12 + 0.33 * pressure);
  return round2(0.3 + 0.65 * pressure);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Settle a pencil or shade stroke's look from its points: whether it is shading, and its opacity. */
export function settlePencil(stroke) {
  if (stroke.tool !== "pencil" && stroke.tool !== "shade") return stroke;
  stroke.shade = isShading(stroke);
  stroke.opacity = pencilOpacity(stroke);
  return stroke;
}
