// Turning stroke vectors into pressure-shaped outlines with perfect-freehand, cached per stroke.

import { getStroke } from "../vendor/perfect-freehand.js";
import { paintedSize, pencilOpacity } from "./pencil.js";
import { dashPattern, dashSegments } from "./shapes.js";
import { TOOLS } from "./tools.js";

export { TOOLS } from "./tools.js";

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

/** A paint-bucket fill's outlines as one path; holes wind the other way, so the default nonzero fill leaves them open. */
function fillPath(outlines) {
  const path = new Path2D();
  for (const loop of outlines ?? []) {
    if (loop.length < 3) continue;
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i++) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
  }
  return path;
}

/** Within a layer, bucket fills go under its lines, as paint poured into the shapes; otherwise strokes keep their order. */
export function paintOrder(strokes) {
  if (!strokes.some((stroke) => stroke.tool === "fill")) return strokes;
  return [...strokes.filter((stroke) => stroke.tool === "fill"), ...strokes.filter((stroke) => stroke.tool !== "fill")];
}

export function strokePath(stroke, { last = false } = {}) {
  if (stroke.tool === "fill") return fillPath(stroke.outlines);
  if (stroke.text) return new Path2D(); // a label is painted as text (paintLabel)
  if (stroke.fill) {
    // A painted area (Claude's faces): the polygon through the points, filled flat.
    const path = new Path2D();
    stroke.points.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    path.closePath();
    return path;
  }
  const tool = TOOLS[stroke.tool] || TOOLS.ink;
  // A pencil laid on its side shades: broad and soft rather than a pressure-thinned line.
  const tilted = stroke.tool === "pencil" && stroke.shade;
  const options = {
    size: paintedSize(stroke),
    thinning: tilted ? TOOLS.shade.thinning : tool.thinning ?? 0.5,
    smoothing: tool.smoothing ?? 0.5,
    streamline: tool.streamline ?? 0.5,
    simulatePressure: stroke.simulatePressure,
    last,
  };
  if (stroke.dash) {
    // A dashed shape: each dash is its own little stroke, all in one path.
    const path = new Path2D();
    for (const piece of dashSegments(stroke.points, ...dashPattern(stroke.size))) {
      path.addPath(outlineToPath(getStroke(piece.map(([x, y]) => [x, y, 0.5]), { ...options, last: true })));
    }
    return path;
  }
  return outlineToPath(getStroke(stroke.points.map(([x, y, p]) => [x, y, p]), options));
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

// ------------------------------------------------------------------ graphite grain

const GRAIN_SIZE = 128;
const grains = new Map(); // "kind color" -> CanvasPattern

/** Seeded noise, so the paper's tooth looks the same on every redraw and every device. */
function noise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fill that looks like graphite on paper: the colour with speckled holes where the pencil skips the
 * paper's tooth. Shading skips more of it than a line does. The pattern lives in paper space, so the
 * grain stays put on the paper when it is moved or zoomed.
 */
function grainPattern(ctx, kind, color) {
  const key = `${kind} ${color}`;
  if (grains.has(key)) return grains.get(key);
  const tile = document.createElement("canvas");
  tile.width = tile.height = GRAIN_SIZE;
  const tileCtx = tile.getContext("2d");
  tileCtx.fillStyle = color;
  tileCtx.fillRect(0, 0, GRAIN_SIZE, GRAIN_SIZE);
  const image = tileCtx.getImageData(0, 0, GRAIN_SIZE, GRAIN_SIZE);
  const random = noise(kind === "shade" ? 7 : 3);
  for (let i = 3; i < image.data.length; i += 4) {
    const r = random();
    image.data[i] = kind === "shade" ? Math.round(255 * r ** 1.6) : Math.round(255 * (0.45 + 0.55 * r ** 0.6));
  }
  tileCtx.putImageData(image, 0, 0);
  const pattern = ctx.createPattern(tile, "repeat");
  // Shading grain is coarser: the side of the lead touches only the tops of the paper's tooth.
  const scale = kind === "shade" ? 1.4 : 0.7;
  pattern?.setTransform?.(new DOMMatrix([scale, 0, 0, scale, 0, 0]));
  grains.set(key, pattern);
  return pattern;
}

function grainKind(stroke) {
  if (stroke.tool === "shade" || (stroke.tool === "pencil" && stroke.shade)) return "shade";
  return TOOLS[stroke.tool]?.grain ?? null;
}

export function strokeOpacity(stroke) {
  if (stroke.tool === "pencil" || stroke.tool === "shade") return stroke.opacity ?? pencilOpacity(stroke);
  return stroke.opacity ?? 1;
}

export const LABEL_FONT = "600 {size}px Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/**
 * A label Claude wrote: text at its point, `size` paper units tall, aligned left / center / right of it, on a soft
 * paper-coloured backing so it stays readable over lines and fills.
 */
export function paintLabel(ctx, stroke) {
  const [x, y] = stroke.points[0] ?? [0, 0];
  const size = stroke.size || 18;
  const lines = String(stroke.text).split("\n");
  ctx.save();
  ctx.globalAlpha = stroke.opacity ?? 1;
  ctx.font = LABEL_FONT.replace("{size}", String(size));
  ctx.textAlign = stroke.align === "center" || stroke.align === "right" ? stroke.align : "left";
  ctx.textBaseline = "middle";
  const lineHeight = size * 1.25;
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const left = ctx.textAlign === "center" ? x - width / 2 : ctx.textAlign === "right" ? x - width : x;
  const pad = size * 0.25;
  ctx.fillStyle = "rgba(245, 245, 242, 0.82)";
  ctx.beginPath();
  ctx.roundRect(left - pad, y - lineHeight / 2 - pad * 0.4, width + pad * 2, lineHeight * lines.length + pad * 0.8, size * 0.3);
  ctx.fill();
  ctx.fillStyle = stroke.color || "#1f2328";
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
  ctx.restore();
}

export function paintStroke(ctx, stroke, path) {
  if (stroke.text) { paintLabel(ctx, stroke); return; }
  ctx.globalAlpha = strokeOpacity(stroke);
  const blend = TOOLS[stroke.tool]?.blend;
  if (blend) ctx.globalCompositeOperation = blend;
  const kind = grainKind(stroke);
  ctx.fillStyle = (kind && grainPattern(ctx, kind, stroke.color)) || stroke.color;
  ctx.fill(path);
  ctx.globalAlpha = 1;
  if (blend) ctx.globalCompositeOperation = "source-over";
}
