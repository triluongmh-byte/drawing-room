// The paint bucket: fill the closed area around a point, like Paint. The lines on the paper are rasterised into a wall
// mask, the area is flooded from the tapped point, and its edge is traced back into vector outlines, so a fill is a
// stroke like any other: saved, undone, erased and exported with the rest. Pure functions on masks, no DOM.

/** Mask pixels per paper unit. */
export const FILL_RES = 2;
/** A fill reaches this many mask pixels under the lines around it, so no white seam shows between fill and line. */
export const TUCK = 2;
/** The traced outline may be this far (mask pixels) from the pixel edge: smooths the staircase. */
export const SIMPLIFY = 0.8;

/** Grow a mask (Uint8Array, 1 = set) by `r` pixels in every direction (a square), in two separable passes. */
export function dilate(mask, w, h, r) {
  if (r <= 0) return mask.slice();
  const row = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity; // the last set pixel to the left
    const base = y * w;
    // Distance to the nearest set pixel along the row, both ways.
    for (let x = 0; x < w; x++) { if (mask[base + x]) last = x; if (x - last <= r) row[base + x] = 1; }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) { if (mask[base + x]) last = x; if (last - x <= r) row[base + x] = 1; }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) { if (row[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) { if (row[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

/** The 4-connected area of non-wall pixels around (sx, sy), or null when the point is on a wall or off the mask. */
export function flood(walls, w, h, sx, sy) {
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || walls[sy * w + sx]) return null;
  const area = new Uint8Array(w * h);
  const stack = [sx, sy];
  let count = 0;
  while (stack.length) {
    const y = stack.pop(), x0 = stack.pop();
    let x = x0;
    while (x > 0 && !walls[y * w + x - 1] && !area[y * w + x - 1]) x--;
    let up = false, down = false;
    for (; x < w && !walls[y * w + x] && !area[y * w + x]; x++) {
      area[y * w + x] = 1;
      count++;
      if (y > 0) {
        const open = !walls[(y - 1) * w + x] && !area[(y - 1) * w + x];
        if (open && !up) stack.push(x, y - 1);
        up = open;
      }
      if (y < h - 1) {
        const open = !walls[(y + 1) * w + x] && !area[(y + 1) * w + x];
        if (open && !down) stack.push(x, y + 1);
        down = open;
      }
    }
  }
  return { area, count };
}

/**
 * The fill area for a tap: flood with gaps up to `gap` pixels closed, then grow the result back by the same amount
 * plus TUCK so it reaches into the gaps it closed and slightly under the lines. Never spills past where the flood
 * could reach with the gaps open.
 */
export function fillArea(walls, w, h, sx, sy, gap = 0) {
  const open = flood(walls, w, h, sx, sy);
  const closed = gap > 0 ? dilate(walls, w, h, gap) : walls;
  const seed = gap > 0 ? flood(closed, w, h, sx, sy) : open;
  if (!seed) {
    // The tap is in a spot narrower than the gap (a sharp corner): fill what the lines themselves enclose.
    return open ? { area: dilate(open.area, w, h, TUCK), count: open.count } : null;
  }
  // The shape is closed (the open flood is about the size of the gap-closed one): use the exact area, so the paint
  // reaches right into sharp corners. Only a leaking shape needs the gap-closed one.
  const grownGuess = seed.count + gap * 4 * Math.sqrt(seed.count) * 2;
  if (open && open.count <= grownGuess * 1.1) {
    const area = dilate(open.area, w, h, TUCK);
    return { area, count: area.reduce((a, b) => a + b, 0) };
  }
  const grown = dilate(seed.area, w, h, gap + TUCK);
  // Keep it inside what an unclosed flood reaches plus the lines themselves, so it cannot jump a line.
  const limit = open ? dilate(open.area, w, h, TUCK) : seed.area;
  let count = 0;
  for (let i = 0; i < grown.length; i++) { grown[i] &= limit[i]; count += grown[i]; }
  return { area: grown, count };
}

/**
 * The outlines of a mask as closed loops of [x, y] mask-pixel corners. Each loop keeps the area on the same side, so
 * outer edges and holes wind opposite ways and a plain (nonzero) fill draws holes as holes.
 */
export function traceOutlines(mask, w, h, simplify = SIMPLIFY) {
  const W = w + 1;
  const next = new Map(); // vertex key -> list of vertex keys an edge goes to
  const add = (ax, ay, bx, by) => {
    const key = ay * W + ax;
    const list = next.get(key);
    if (list) list.push(by * W + bx); else next.set(key, [by * W + bx]);
  };
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops = [];
  for (const start of next.keys()) {
    while (next.get(start)?.length) {
      const loop = [];
      let key = start;
      do {
        loop.push([key % W, Math.floor(key / W)]);
        const list = next.get(key);
        const to = list.pop();
        if (!list.length) next.delete(key);
        key = to;
      } while (key !== start && next.has(key));
      if (loop.length >= 4) loops.push(simplifyLoop(loop, simplify));
    }
  }
  return loops.filter((loop) => loop.length >= 3);
}

function distance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (!length) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / length;
}

/** Ramer–Douglas–Peucker on an open polyline. */
function rdp(points, epsilon) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, far = epsilon;
    for (let k = i + 1; k < j; k++) {
      const d = distance(points[k], points[i], points[j]);
      if (d > far) { far = d; best = k; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplify a closed loop: split it at its far point so both halves keep their ends. */
export function simplifyLoop(loop, epsilon = SIMPLIFY) {
  if (loop.length < 8 || epsilon <= 0) return loop;
  let far = 0, best = 0;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > far) { far = d; best = i; }
  }
  const first = rdp(loop.slice(0, best + 1), epsilon);
  const second = rdp([...loop.slice(best), loop[0]], epsilon);
  return [...first, ...second.slice(1, -1)];
}

/** Mask outlines to paper units, rounded to 0.1, for a sheet starting at (x0, y0). */
export function toPaper(loops, x0, y0, res = FILL_RES) {
  const round = (v) => Math.round(v * 10) / 10;
  return loops.map((loop) => loop.map(([x, y]) => [round(x0 + x / res), round(y0 + y / res)]));
}

/** Whether a paper point is inside a fill's outlines (nonzero winding, like the drawing). */
export function insideOutlines(outlines, x, y) {
  let winding = 0;
  for (const loop of outlines) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [ax, ay] = loop[j], [bx, by] = loop[i];
      if (ay <= y) { if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) winding++; }
      else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) winding--;
    }
  }
  return winding !== 0;
}
