// Paper sizes. The reference and scoring frame stays 1000 x 750 paper units; the sheet is a chosen shape around it,
// centred on it and just big enough to hold it. Outside the sheet is the desk. Pure, no DOM.

export const FRAME_W = 1000;
export const FRAME_H = 750;

export const PAPERS = {
  frame: { name: "4:3 (the reference frame)", aspect: 4 / 3 },
  "a4-landscape": { name: "A4 landscape", aspect: 297 / 210 },
  "a4-portrait": { name: "A4 portrait", aspect: 210 / 297 },
  square: { name: "Square", aspect: 1 },
  wide: { name: "16:9 wide", aspect: 16 / 9 },
  tall: { name: "9:16 tall", aspect: 9 / 16 },
};

export const DEFAULT_PAPER = "frame";

export function paperId(value) {
  return Object.hasOwn(PAPERS, value) ? value : DEFAULT_PAPER;
}

/** The sheet as [x0, y0, x1, y1] in paper units: the chosen aspect, holding the whole frame, centred on it. */
export function sheetRect(id) {
  const { aspect } = PAPERS[paperId(id)];
  let w = FRAME_W, h = FRAME_H;
  if (aspect >= FRAME_W / FRAME_H) w = FRAME_H * aspect;
  else h = FRAME_W / aspect;
  const x0 = (FRAME_W - w) / 2, y0 = (FRAME_H - h) / 2;
  const round = (v) => Math.round(v * 10) / 10;
  return [round(x0), round(y0), round(x0 + w), round(y0 + h)];
}

export const COORD_LIMIT = 6000; // the server's limit on paper coordinates

/**
 * The area worth showing (to Claude, in layer thumbnails): the sheet, grown to take in every stroke, since the paper
 * has no edge and strokes may run past the sheet. `boxes` are {x0, y0, x1, y1} or null; clamped to ±COORD_LIMIT.
 */
export function drawingBounds(sheet, boxes) {
  let [x0, y0, x1, y1] = sheet;
  for (const box of boxes) {
    if (!box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) continue;
    x0 = Math.min(x0, box.x0); y0 = Math.min(y0, box.y0); x1 = Math.max(x1, box.x1); y1 = Math.max(y1, box.y1);
  }
  const clamp = (v) => Math.round(Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v)) * 10) / 10;
  return [clamp(x0), clamp(y0), clamp(x1), clamp(y1)];
}

/**
 * Grid lines to draw over the paper-space box [x0, y0, x1, y1] at `scale` screen px per paper unit: a line every
 * `step` units (50, or 5x coarser until lines are at least `minGap` px apart), every fifth one major.
 */
export function gridLines([x0, y0, x1, y1], scale, minGap = 10) {
  let step = 50;
  while (step * scale < minGap) step *= 5;
  const lines = { step, minor: { x: [], y: [] }, major: { x: [], y: [] } };
  for (const [axis, from, to] of [["x", x0, x1], ["y", y0, y1]]) {
    for (let v = Math.ceil(from / step) * step + 0; v <= to; v += step) {
      (Math.round(v / step) % 5 === 0 ? lines.major : lines.minor)[axis].push(v);
    }
  }
  return lines;
}
