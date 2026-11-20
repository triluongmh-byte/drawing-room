// The drawing tools and the size and colour each one remembers. Pure, no DOM, so it can be tested with `node --test`.

// `size` is the default width and [min, max] the size slider's range, in paper pixels (screen pixels for the eraser).
export const TOOLS = {
  pencil: { label: "Pencil", color: "#3b3936", size: 3, min: 1, max: 12, thinning: 0.72, smoothing: 0.5, streamline: 0.35, grain: "line" },
  shade: { label: "Shade", color: "#3b3936", size: 26, min: 8, max: 70, thinning: 0.3, smoothing: 0.7, streamline: 0.5, grain: "shade" },
  ink: { label: "Ink", color: "#141312", size: 4.5, min: 1, max: 16, opacity: 1, thinning: 0.6, smoothing: 0.6, streamline: 0.45 },
  // A felt-tip: even width whatever the pressure, nearly opaque.
  marker: { label: "Marker", color: "#1f2328", size: 6, min: 2, max: 24, opacity: 0.92, thinning: 0, smoothing: 0.6, streamline: 0.5 },
  brush: { label: "Color brush", color: "#e0604a", size: 22, min: 4, max: 80, opacity: 0.45, thinning: 0.25, smoothing: 0.6, streamline: 0.5 },
  // Wide, flat and see-through; multiplied onto the paper so lines under it stay dark. Never scored.
  highlighter: { label: "Highlighter", color: "#ffd43b", size: 20, min: 6, max: 60, opacity: 0.4, thinning: 0, smoothing: 0.7, streamline: 0.55, blend: "multiply" },
  eraser: { label: "Eraser", size: 12, min: 4, max: 60 },
};

/** The left toolbox: writing tools and painting tools, each group with its own colours. */
export const GROUPS = {
  write: { label: "Write", tools: ["pencil", "ink", "marker"],
           palette: ["#141312", "#3b3936", "#2f6fd0", "#2e8b57", "#d9822b", "#d64545"] },
  paint: { label: "Paint", tools: ["brush", "shade", "highlighter"],
           palette: ["#e0604a", "#f2b636", "#ffd43b", "#4ba3c7", "#6bbf59", "#8e6cc9"] },
};

/** Tools with a colour of their own (the eraser has none). */
export const COLORED = Object.values(GROUPS).flatMap((group) => group.tools);

/** The group a tool belongs to ("write", "paint"), or null for the eraser. */
export function groupOf(tool) {
  return Object.keys(GROUPS).find((name) => GROUPS[name].tools.includes(tool)) ?? null;
}

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

/**
 * One colour for every tool in `tool`'s group, so switching from the pencil to the ink keeps the colour just
 * picked, while the paint tools (a yellow highlighter, say) keep theirs.
 */
export function shareColor(settings, color, tool) {
  const group = groupOf(tool);
  if (!group || !HEX.test(color ?? "")) return settings;
  for (const member of GROUPS[group].tools) settings[member].color = color.toLowerCase();
  return settings;
}
