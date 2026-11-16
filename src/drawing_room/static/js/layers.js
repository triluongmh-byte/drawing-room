// Fixed layers, bottom to top. The reference layer is an image underlay; the others hold strokes.

export const LAYERS = [
  { id: "reference", name: "Reference", drawable: false },
  { id: "sketch", name: "Sketch", drawable: true },
  { id: "line", name: "Line", drawable: true },
  { id: "color", name: "Color", drawable: true },
];

export const DRAWABLE = LAYERS.filter((layer) => layer.drawable).map((layer) => layer.id);

export const TOOL_LAYER = { pencil: "sketch", ink: "line", brush: "color" };

export function createLayerState() {
  return {
    visible: Object.fromEntries(LAYERS.map((layer) => [layer.id, true])),
    active: "sketch",
    referenceOpacity: 0.35,
    // Levels 3 and 4 hide the underlay; the person cannot turn it back on there.
    referenceLocked: false,
  };
}

export function isVisible(state, id) {
  if (id === "reference" && state.referenceLocked) return false;
  return Boolean(state.visible[id]);
}

export function toggleVisible(state, id) {
  if (!(id in state.visible)) throw new Error(`unknown layer ${id}`);
  if (id === "reference" && state.referenceLocked) return state;
  state.visible[id] = !state.visible[id];
  return state;
}

export function setActive(state, id) {
  if (!DRAWABLE.includes(id)) throw new Error(`cannot draw on layer ${id}`);
  state.active = id;
  return state;
}

/** Picking a drawing tool also picks its layer; the eraser keeps whatever layer is active. */
export function layerForTool(state, tool) {
  return TOOL_LAYER[tool] ?? state.active;
}

export function setReferenceOpacity(state, value) {
  const number = Number(value);
  state.referenceOpacity = Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : state.referenceOpacity;
  return state;
}

/** Layers to paint, bottom to top. */
export function paintOrder(state) {
  return LAYERS.map((layer) => layer.id).filter((id) => isVisible(state, id));
}
