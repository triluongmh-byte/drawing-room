// Basic shapes, like Paint: drag from one corner to the other for a line, rectangle, ellipse or triangle. Hold Shift
// for a square, circle, equilateral-looking triangle or a line in 15° steps. The shape becomes an ordinary stroke
// (points every STEP paper units), so it can be filled, erased, undone and saved; it is never scored. Pure, no DOM.

export const SHAPES = {
  line: { label: "Line", icon: "╱" },
  rect: { label: "Rectangle", icon: "▭" },
  ellipse: { label: "Ellipse", icon: "◯" },
  triangle: { label: "Triangle", icon: "△" },
};
export const DEFAULT_SHAPE = "rect";
export const STEP = 2;
const SNAP = Math.PI / 12; // 15°

export function shapeKind(value) {
  return Object.hasOwn(SHAPES, value) ? value : DEFAULT_SHAPE;
}

/** Points every `step` along a polyline, keeping every corner exactly. */
export function densify(corners, step = STEP) {
  const out = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1], [bx, by] = corners[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** With `even`, the drag's box becomes square, keeping the direction of the drag. */
function box([ax, ay], [bx, by], even) {
  let dx = bx - ax, dy = by - ay;
  if (even) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side; dy = Math.sign(dy || 1) * side;
  }
  return [ax, ay, ax + dx, ay + dy];
}

/** The outline of a shape dragged from `a` to `b`, as [x, y] paper points. */
export function shapePoints(kind, a, b, { even = false, step = STEP } = {}) {
  if (kind === "line") {
    let [bx, by] = b;
    if (even) {
      const length = Math.hypot(bx - a[0], by - a[1]);
      const angle = Math.round(Math.atan2(by - a[1], bx - a[0]) / SNAP) * SNAP;
      bx = a[0] + length * Math.cos(angle); by = a[1] + length * Math.sin(angle);
    }
    return densify([a, [bx, by]], step);
  }
  const [x0, y0, x1, y1] = box(a, b, even);
  if (kind === "ellipse") {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    // Ramanujan's perimeter, for an even spacing of points.
    const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
    const n = Math.max(24, Math.ceil(perimeter / step));
    const points = [];
    for (let i = 0; i <= n; i++) {
      const t = -Math.PI / 2 + (2 * Math.PI * i) / n;
      points.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
    }
    return points;
  }
  if (kind === "triangle") {
    // Apex in the middle of the top edge (of the drag direction), base along the other edge.
    return densify([[(x0 + x1) / 2, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, y0]], step);
  }
  return densify([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], step);
}
