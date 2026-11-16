// The paper's place on screen: screen = translate + rotate(rotation) * scale * paper.

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 12;

export function createView() {
  return { x: 0, y: 0, scale: 1, rotation: 0 };
}

const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

export function paperToScreen(view, px, py) {
  const c = Math.cos(view.rotation) * view.scale, s = Math.sin(view.rotation) * view.scale;
  return [view.x + c * px - s * py, view.y + s * px + c * py];
}

export function screenToPaper(view, sx, sy) {
  const dx = sx - view.x, dy = sy - view.y;
  const c = Math.cos(view.rotation) / view.scale, s = Math.sin(view.rotation) / view.scale;
  return [c * dx + s * dy, -s * dx + c * dy];
}

/** Centre the paper in the viewport, upright, as large as fits with a margin. */
export function fitView(paperW, paperH, viewW, viewH, margin = 24) {
  const scale = clampScale(Math.min((viewW - 2 * margin) / paperW, (viewH - 2 * margin) / paperH));
  return { x: (viewW - paperW * scale) / 2, y: (viewH - paperH * scale) / 2, scale, rotation: 0 };
}

export function pan(view, dx, dy) {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** Zoom by `factor` keeping the paper point under (sx, sy) fixed. */
export function zoomAt(view, sx, sy, factor) {
  const [px, py] = screenToPaper(view, sx, sy);
  const next = { ...view, scale: clampScale(view.scale * factor) };
  const [nx, ny] = paperToScreen(next, px, py);
  return { ...next, x: next.x + sx - nx, y: next.y + sy - ny };
}

/** Rotate by `angle` radians about the screen point (sx, sy). */
export function rotateAt(view, sx, sy, angle) {
  const [px, py] = screenToPaper(view, sx, sy);
  const next = { ...view, rotation: view.rotation + angle };
  const [nx, ny] = paperToScreen(next, px, py);
  return { ...next, x: next.x + sx - nx, y: next.y + sy - ny };
}

/**
 * Two-finger gesture: given the view and finger positions when the gesture started (a0, b0) and now (a1, b1),
 * the view that keeps the paper "stuck" under the fingers (pan + pinch zoom + twist rotate).
 */
export function gestureView(start, a0, b0, a1, b1, { rotate = true } = {}) {
  const mid0 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
  const mid1 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1;
  const d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]) || 1;
  const angle = rotate ? Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - Math.atan2(b0[1] - a0[1], b0[0] - a0[0]) : 0;
  const [px, py] = screenToPaper(start, mid0[0], mid0[1]);
  const next = { ...start, scale: clampScale(start.scale * d1 / d0), rotation: start.rotation + angle };
  const [nx, ny] = paperToScreen(next, px, py);
  return { ...next, x: next.x + mid1[0] - nx, y: next.y + mid1[1] - ny };
}
