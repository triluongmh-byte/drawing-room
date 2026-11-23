// Layers like a paint program: an ordered stack the person can add to, rename, reorder, hide, lock and delete.
// The reference image is not one of them: it is a fixed underlay below the stack, with its own state.
// Pure functions and plain objects, no DOM, so they can be tested with `node --test`.

export const MAX_LAYERS = 24;
export const MAX_NAME = 40;

let nextId = 1;

function clamp01(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

/** A layer name: trimmed, single-line, at most MAX_NAME characters. Empty names fall back. */
export function cleanName(name, fallback = "Layer") {
  const text = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return text || fallback;
}

export function createLayer({ id, name = "Layer", visible = true, opacity = 1, locked = false, scored = true, strokes = [] } = {}) {
  return {
    id: id ?? `l${Date.now().toString(36)}${(nextId++).toString(36)}`,
    name: cleanName(name),
    visible: Boolean(visible),
    opacity: clamp01(opacity, 1),
    locked: Boolean(locked),
    // Whether this layer's ink counts towards the score and is shown to the coach.
    scored: Boolean(scored),
    strokes: Array.isArray(strokes) ? strokes : [],
  };
}

/** A new drawing: Sketch and Line are scored, Color is not. Bottom to top. */
export function createDocument() {
  return {
    layers: [
      createLayer({ id: "sketch", name: "Sketch" }),
      createLayer({ id: "line", name: "Line" }),
      createLayer({ id: "color", name: "Color", scored: false }),
    ],
  };
}

export function getLayer(doc, id) {
  return doc.layers.find((layer) => layer.id === id) ?? null;
}

export function layerIndex(doc, id) {
  return doc.layers.findIndex((layer) => layer.id === id);
}

/** "Layer N" with the lowest N (from the new layer count up) not already taken. */
export function nextLayerName(doc) {
  const taken = new Set(doc.layers.map((layer) => layer.name.toLowerCase()));
  for (let n = doc.layers.length + 1; ; n++) {
    if (!taken.has(`layer ${n}`)) return `Layer ${n}`;
  }
}

/** A layer takes new strokes only while it is shown and unlocked. */
export function canDraw(layer) {
  return Boolean(layer && layer.visible && !layer.locked);
}

export function setLayerOpacity(layer, value) {
  layer.opacity = clamp01(value, layer.opacity);
  return layer;
}

/** Strokes from every layer, bottom to top; `filter(layer)` picks which layers. */
export function allStrokes(doc, filter = () => true) {
  return doc.layers.filter(filter).flatMap((layer) => layer.strokes);
}

/** Strokes for scoring and the coach: visible layers only, each tagged with whether its layer is scored. */
export function strokesForScoring(doc, serialize = (stroke) => stroke) {
  return doc.layers.filter((layer) => layer.visible)
    // Bucket fills are colour, not line: they never count and the coach does not see them as strokes.
    .flatMap((layer) => layer.strokes.filter((stroke) => stroke.tool !== "fill").map((stroke) => ({ ...serialize(stroke), scored: layer.scored })));
}

// ------------------------------------------------------------------ the reference underlay

export function createReferenceState() {
  // Levels 3 and 4 lock it hidden; the person cannot turn it back on there.
  return { visible: true, opacity: 0.35, locked: false };
}

export function referenceVisible(reference) {
  return reference.visible && !reference.locked;
}

export function setReferenceOpacity(reference, value) {
  reference.opacity = clamp01(value, reference.opacity);
  return reference;
}

// ------------------------------------------------------------------ saving

export function serializeDocument(doc) {
  return {
    layers: doc.layers.map(({ id, name, visible, opacity, locked, scored, strokes }) => ({ id, name, visible, opacity, locked, scored, strokes })),
  };
}

function validStrokes(strokes, layerId) {
  return Array.isArray(strokes) ? strokes.filter((s) => s && Array.isArray(s.points)).map((s) => ({ ...s, layer: layerId })) : [];
}

/**
 * A document from saved data. Reads the current format (a list of layers) and the v0 format
 * (`{sketch: [...], line: [...], color: [...]}`); anything unreadable gives a fresh document.
 */
export function restoreDocument(saved) {
  if (Array.isArray(saved?.layers)) {
    const seen = new Set();
    const layers = [];
    for (const layer of saved.layers) {
      if (!layer || typeof layer.id !== "string" || seen.has(layer.id) || layers.length >= MAX_LAYERS) continue;
      seen.add(layer.id);
      layers.push(createLayer({ ...layer, strokes: validStrokes(layer.strokes, layer.id) }));
    }
    if (layers.length) return { layers };
  }
  const doc = createDocument();
  if (saved?.layers && typeof saved.layers === "object" && !Array.isArray(saved.layers)) {
    for (const layer of doc.layers) layer.strokes = validStrokes(saved.layers[layer.id], layer.id);
  }
  return doc;
}
