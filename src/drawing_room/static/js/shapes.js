// Shapes drawn by dragging: a line, rectangle, ellipse, triangle, diamond or arrow from where the drag starts (`a`)
// to where it is now (`b`). Each comes out as a polyline in paper pixels, painted like any other stroke.
// Pure functions, no DOM, so they can be tested with `node --test`.

export const SHAPES = {
  line: { label: "Line", icon: "slash" },
  rect: { label: "Rectangle", icon: "square" },
  ellipse: { label: "Ellipse", icon: "circle" },
  triangle: { label: "Triangle", icon: "triangle" },
  diamond: { label: "Diamond", icon: "diamond" },
  arrow: { label: "Arrow", icon: "arrow-up-right" },
};

const STEP = 8; // paper pixels between points along a straight side
const ELLIPSE_POINTS = 96;
const ANGLE_STEP = 15; // degrees, for a constrained line or arrow

/** Points every STEP pixels from p to q, p included, q left out (the next side starts there). */
function side([x0, y0], [x1, y1]) {
  const count = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
  return Array.from({ length: count }, (_, i) => [x0 + ((x1 - x0) * i) / count, y0 + ((y1 - y0) * i) / count]);
}

function path(corners, closed = false) {
  const points = [];
  const all = closed ? [...corners, corners[0]] : corners;
  for (let i = 0; i < all.length - 1; i++) points.push(...side(all[i], all[i + 1]));
  points.push([...all.at(-1)]);
  return points;
}

/** With Shift: an equal-sided box (square, circle) from `a` toward `b`. */
function squareUp(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return [a[0] + Math.sign(dx || 1) * size, a[1] + Math.sign(dy || 1) * size];
}

/** With Shift: the end of a line turned to the nearest 15° step, same length. */
export function snapAngle(a, b) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const step = (ANGLE_STEP * Math.PI) / 180;
  const angle = Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) / step) * step;
  return [a[0] + Math.cos(angle) * length, a[1] + Math.sin(angle) * length];
}

/** The shape `kind` dragged from `a` to `b` as points; `constrain` (Shift) makes it even. */
export function shapePoints(kind, a, b, { constrain = false } = {}) {
  if (kind === "line" || kind === "arrow") {
    const end = constrain ? snapAngle(a, b) : b;
    const line = path([a, end]);
    if (kind === "line") return line;
    const length = Math.hypot(end[0] - a[0], end[1] - a[1]);
    if (length < 1) return line;
    const head = Math.min(40, Math.max(10, length * 0.25));
    const angle = Math.atan2(end[1] - a[1], end[0] - a[0]);
    const wing = (turn) => [end[0] - Math.cos(angle + turn) * head, end[1] - Math.sin(angle + turn) * head];
    const spread = (28 * Math.PI) / 180;
    // One stroke: along the shaft to the tip, out to one wing, back to the tip, out to the other.
    return [...line, ...path([end, wing(spread)]).slice(1), ...path([wing(spread), end]).slice(1), ...path([end, wing(-spread)]).slice(1)];
  }
  const corner = constrain ? squareUp(a, b) : b;
  const x0 = Math.min(a[0], corner[0]), x1 = Math.max(a[0], corner[0]);
  const y0 = Math.min(a[1], corner[1]), y1 = Math.max(a[1], corner[1]);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (kind === "ellipse") {
    const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    return Array.from({ length: ELLIPSE_POINTS + 1 }, (_, i) => {
      const t = (2 * Math.PI * i) / ELLIPSE_POINTS - Math.PI / 2;
      return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
    });
  }
  if (kind === "triangle") return path([[cx, y0], [x1, y1], [x0, y1]], true);
  if (kind === "diamond") return path([[cx, y0], [x1, cy], [cx, y1], [x0, cy]], true);
  return path([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true); // rect, and anything unknown
}

/** Dash and gap lengths for a dashed line of width `size`, in paper pixels: longer dashes for thicker lines. */
export function dashPattern(size) {
  return [Math.max(8, size * 4), Math.max(6, size * 3)];
}

/**
 * Cut a polyline into dashes: the pieces of it that are "on", walking `dash` pixels on, `gap` off, along its
 * length (corners included). Each piece is a list of [x, y] with at least two points.
 */
export function dashSegments(points, dash, gap) {
  const pieces = [];
  if (points.length < 2 || !(dash > 0) || !(gap > 0)) return points.length >= 2 ? [points.map(([x, y]) => [x, y])] : [];
  let on = true, left = dash, current = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length; i++) {
    let [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    let length = Math.hypot(x1 - x0, y1 - y0);
    while (length > left) {
      const t = left / length;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (on) { current.push([x, y]); pieces.push(current); } else current = [[x, y]];
      on = !on;
      length -= left;
      x0 = x; y0 = y;
      left = on ? dash : gap;
    }
    left -= length;
    if (on) current.push([x1, y1]);
  }
  if (on && current.length > 1) pieces.push(current);
  return pieces;
}

/** Whether a drag is big enough to be a shape rather than a stray tap. */
export function bigEnough(a, b, min = 3) {
  return Math.abs(b[0] - a[0]) >= min || Math.abs(b[1] - a[1]) >= min;
}
