// A straightedge on the paper. Drag its ends to turn it (snapping to round angles), drag its middle to
// move it; a stroke that starts close to it is pulled onto its line. Paper coordinates, y pointing down.
// Pure functions, no DOM, so they can be tested with `node --test`.

export const SNAP_STEP = 15; // degrees
export const SNAP_TOLERANCE = 3; // degrees
export const MIN_LENGTH = 40;

export function createRuler(cx = 500, cy = 375, length = 600, degrees = 0) {
  return setAngle({ a: [cx - length / 2, cy], b: [cx + length / 2, cy] }, degrees);
}

export function rulerLength(ruler) {
  return Math.hypot(ruler.b[0] - ruler.a[0], ruler.b[1] - ruler.a[1]);
}

export function rulerCenter(ruler) {
  return [(ruler.a[0] + ruler.b[0]) / 2, (ruler.a[1] + ruler.b[1]) / 2];
}

function normalizeDegrees(degrees) {
  return ((degrees % 180) + 180) % 180;
}

/** The ruler's angle as people read it: 0° is level, 90° upright, counter-clockwise, in [0, 180). */
export function rulerAngle(ruler) {
  const degrees = (Math.atan2(-(ruler.b[1] - ruler.a[1]), ruler.b[0] - ruler.a[0]) * 180) / Math.PI;
  const value = normalizeDegrees(Math.round(degrees * 10) / 10);
  return value === 180 ? 0 : value;
}

/** Snap to the nearest multiple of `step` when within `tolerance` degrees of it. */
export function snapDegrees(degrees, step = SNAP_STEP, tolerance = SNAP_TOLERANCE) {
  const nearest = Math.round(degrees / step) * step;
  return Math.abs(degrees - nearest) <= tolerance ? nearest : degrees;
}

/** Turn the ruler about its centre to an angle in degrees, keeping its length. */
export function setAngle(ruler, degrees) {
  const number = Number(degrees);
  if (!Number.isFinite(number)) return ruler;
  const [cx, cy] = rulerCenter(ruler);
  const half = rulerLength(ruler) / 2;
  const radians = (number * Math.PI) / 180;
  const ux = Math.cos(radians), uy = -Math.sin(radians);
  return { a: [cx - ux * half, cy - uy * half], b: [cx + ux * half, cy + uy * half] };
}

/** Move one end ("a" or "b") to `point`, turning about the other end. Angles snap unless `snap` is false. */
export function dragEnd(ruler, which, point, { snap = true } = {}) {
  const fixed = which === "a" ? ruler.b : ruler.a;
  const dx = point[0] - fixed[0], dy = point[1] - fixed[1];
  let degrees = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (snap) degrees = snapDegrees(degrees);
  const length = Math.max(MIN_LENGTH, Math.hypot(dx, dy));
  const radians = (degrees * Math.PI) / 180;
  const moved = [fixed[0] + Math.cos(radians) * length, fixed[1] - Math.sin(radians) * length];
  return which === "a" ? { a: moved, b: [...ruler.b] } : { a: [...ruler.a], b: moved };
}

export function moveRuler(ruler, dx, dy) {
  return { a: [ruler.a[0] + dx, ruler.a[1] + dy], b: [ruler.b[0] + dx, ruler.b[1] + dy] };
}

/** The point on the ruler's (endless) line nearest to `point`. */
export function projectOnto(ruler, [x, y]) {
  const [ax, ay] = ruler.a, [bx, by] = ruler.b;
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = ((x - ax) * dx + (y - ay) * dy) / lengthSquared;
  return [ax + t * dx, ay + t * dy];
}

/** Distance from `point` to the ruler's line, and whether its foot falls along the ruler itself. */
export function distanceToRuler(ruler, point) {
  const [ax, ay] = ruler.a, [bx, by] = ruler.b;
  const dx = bx - ax, dy = by - ay;
  const t = ((point[0] - ax) * dx + (point[1] - ay) * dy) / (dx * dx + dy * dy || 1);
  const [px, py] = projectOnto(ruler, point);
  return { distance: Math.hypot(point[0] - px, point[1] - py), along: t >= 0 && t <= 1 };
}

/** Whether a stroke starting at `point` should follow the ruler. */
export function snapsToRuler(ruler, point, reach) {
  const { distance, along } = distanceToRuler(ruler, point);
  return along && distance <= reach;
}

export const FOLLOW_DEGREES = 25;

/**
 * Whether a stroke heading from `from` to `to` runs along the ruler (either way), within `maxDegrees`.
 * A stroke that starts by the ruler but heads off across it is drawn freehand, not pulled onto it.
 */
export function followsRuler(ruler, from, to, maxDegrees = FOLLOW_DEGREES) {
  const sx = to[0] - from[0], sy = to[1] - from[1];
  const rx = ruler.b[0] - ruler.a[0], ry = ruler.b[1] - ruler.a[1];
  const lengths = Math.hypot(sx, sy) * Math.hypot(rx, ry);
  if (!lengths) return true;
  const cos = Math.abs(sx * rx + sy * ry) / lengths;
  return cos >= Math.cos((maxDegrees * Math.PI) / 180);
}

/** Which handle is under `point`: "a", "b" (the ends), "move" (the middle), or null. */
export function hitHandle(ruler, point, radius) {
  const near = (p) => Math.hypot(point[0] - p[0], point[1] - p[1]) <= radius;
  if (near(ruler.a)) return "a";
  if (near(ruler.b)) return "b";
  if (near(rulerCenter(ruler))) return "move";
  return null;
}

/** A ruler from saved data, or null when it is unusable. */
export function restoreRuler(saved) {
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (!saved || !ok(saved.a) || !ok(saved.b)) return null;
  const ruler = { a: [...saved.a], b: [...saved.b] };
  return rulerLength(ruler) >= 1 ? ruler : null;
}
