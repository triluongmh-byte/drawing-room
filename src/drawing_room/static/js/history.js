// The drawing document and its undo/redo history. Every change to strokes or to the layer stack is a
// command with `apply` and `revert`, so it can be undone and redone.

import { MAX_LAYERS, cleanName, createDocument, createLayer, getLayer, layerIndex, nextLayerName } from "./layers.js";

export { allStrokes, createDocument } from "./layers.js";

export class History {
  constructor(doc = createDocument(), limit = 500) {
    this.doc = doc;
    this.limit = limit;
    this.done = [];
    this.undone = [];
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }

  _run(command) {
    command.apply();
    this.done.push(command);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  _layer(id) {
    const layer = getLayer(this.doc, id);
    if (!layer) throw new Error(`no layer ${id}`);
    return layer;
  }

  // ---------------------------------------------------------------- strokes

  add(stroke) {
    const layer = this._layer(stroke.layer);
    this._run({
      apply: () => layer.strokes.push(stroke),
      revert: () => layer.strokes.splice(layer.strokes.lastIndexOf(stroke), 1),
    });
  }

  _remove(items) {
    this._run({
      apply: () => {
        for (const { layer, stroke } of items) {
          const index = layer.strokes.indexOf(stroke);
          if (index >= 0) layer.strokes.splice(index, 1);
        }
      },
      // Put strokes back at their old positions, lowest index first, so the stacking order is restored.
      revert: () => {
        for (const { layer, index, stroke } of [...items].sort((a, b) => a.index - b.index)) layer.strokes.splice(index, 0, stroke);
      },
    });
  }

  /** Remove strokes (one eraser drag) as a single undoable step. */
  erase(strokes) {
    const items = [];
    for (const stroke of strokes) {
      const layer = getLayer(this.doc, stroke.layer);
      const index = layer ? layer.strokes.indexOf(stroke) : -1;
      if (index >= 0) items.push({ layer, index, stroke });
    }
    if (items.length) this._remove(items);
    return items.length;
  }

  /** Empty the given layers (all of them by default) as one undoable step. */
  clear(ids = this.doc.layers.map((layer) => layer.id)) {
    const items = [];
    for (const id of ids) {
      const layer = getLayer(this.doc, id);
      layer?.strokes.forEach((stroke, index) => items.push({ layer, index, stroke }));
    }
    if (items.length) this._remove(items);
    return items.length;
  }

  // ---------------------------------------------------------------- the layer stack

  /** A new empty layer just above `aboveId` (or on top). Returns it, or null when the stack is full. */
  addLayer({ name, scored = true } = {}, aboveId = null) {
    if (this.doc.layers.length >= MAX_LAYERS) return null;
    const layer = createLayer({ name: cleanName(name, nextLayerName(this.doc)), scored });
    const below = aboveId ? layerIndex(this.doc, aboveId) : -1;
    const index = below >= 0 ? below + 1 : this.doc.layers.length;
    this._run({
      apply: () => this.doc.layers.splice(index, 0, layer),
      revert: () => this.doc.layers.splice(this.doc.layers.indexOf(layer), 1),
    });
    return layer;
  }

  /** Delete a layer and its strokes. The last layer cannot be deleted. */
  removeLayer(id) {
    const index = layerIndex(this.doc, id);
    if (index < 0 || this.doc.layers.length <= 1) return false;
    const layer = this.doc.layers[index];
    this._run({
      apply: () => this.doc.layers.splice(this.doc.layers.indexOf(layer), 1),
      revert: () => this.doc.layers.splice(index, 0, layer),
    });
    return true;
  }

  /** Move a layer up (+1, towards the top) or down (-1). */
  moveLayer(id, delta) {
    const from = layerIndex(this.doc, id);
    const to = from + Math.sign(delta);
    if (from < 0 || to < 0 || to >= this.doc.layers.length) return false;
    const swap = () => {
      const a = this.doc.layers.findIndex((layer) => layer.id === id);
      const b = a === from ? to : from;
      [this.doc.layers[a], this.doc.layers[b]] = [this.doc.layers[b], this.doc.layers[a]];
    };
    this._run({ apply: swap, revert: swap });
    return true;
  }

  renameLayer(id, name) {
    const layer = getLayer(this.doc, id);
    if (!layer) return false;
    const before = layer.name;
    const after = cleanName(name, before);
    if (after === before) return false;
    this._run({ apply: () => { layer.name = after; }, revert: () => { layer.name = before; } });
    return true;
  }

  // ---------------------------------------------------------------- undo / redo

  undo() {
    const command = this.done.pop();
    if (!command) return false;
    command.revert();
    this.undone.push(command);
    return true;
  }

  redo() {
    const command = this.undone.pop();
    if (!command) return false;
    command.apply();
    this.done.push(command);
    return true;
  }
}
