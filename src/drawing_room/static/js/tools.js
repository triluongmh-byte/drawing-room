// The drawing tools and the size and colour each one remembers. Pure, no DOM, so it can be tested with `node --test`.

// `size` is the default width and [min, max] the size slider's range, in paper pixels (screen pixels for the eraser).
export const TOOLS = {
  pencil: { label: "Pencil", color: "#3b3936", size: 3, min: 1, max: 12, thinning: 0.72, smoothing: 0.5, streamline: 0.35, grain: "line" },
  shade: { label: "Shade", color: "#3b3936", size: 26, min: 8, max: 70, thinning: 0.3, smoothing: 0.7, streamline: 0.5, grain: "shade" },
  ink: { label: "Ink", color: "#141312", size: 4.5, min: 1, max: 16, opacity: 1, thinning: 0.6, smoothing: 0.6, streamline: 0.45 },
  brush: { label: "Color", color: "#e0604a", size: 22, min: 4, max: 80, opacity: 0.45, thinning: 0.25, smoothing: 0.6, streamline: 0.5 },
  eraser: { label: "Eraser", size: 12, min: 4, max: 60 },
};

/** Tools with a colour of their own (the eraser has none). */
export const COLORED = ["pencil", "shade", "ink", "brush"];

const HEX = /^#[0-9a-f]{6}$/i;

export function clampSize(tool, value) {
  const { min, max, size } = TOOLS[tool];
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number * 2) / 2)) : size;
}

/** Each tool's size and colour, from its defaults overlaid with whatever was saved. */
export function restoreToolSettings(saved = {}) {
  const settings = {};
  for (const [tool, spec] of Object.entries(TOOLS)) {
    const entry = saved?.[tool] ?? {};
    settings[tool] = { size: entry.size === undefined ? spec.size : clampSize(tool, entry.size) };
    if (COLORED.includes(tool)) settings[tool].color = HEX.test(entry.color ?? "") ? entry.color.toLowerCase() : spec.color;
  }
  return settings;
}

/** One step of `[` / `]`: about a tenth of the tool's range, at least half a pixel. */
export function stepSize(tool, current, direction) {
  const { min, max } = TOOLS[tool];
  const step = Math.max(0.5, Math.round(((max - min) / 10) * 2) / 2);
  return clampSize(tool, current + Math.sign(direction) * step);
}

/** One colour for every tool that has one, so switching from the pencil to the ink keeps the colour just picked. */
export function shareColor(settings, color) {
  if (!HEX.test(color ?? "")) return settings;
  for (const tool of COLORED) settings[tool].color = color.toLowerCase();
  return settings;
}
