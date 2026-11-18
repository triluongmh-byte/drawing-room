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
