// The drawing document and its undo/redo history. Every change is a command that can be undone.

import { DRAWABLE } from "./layers.js";

export function createDocument() {
  return { layers: Object.fromEntries(DRAWABLE.map((id) => [id, []])) };
}

export function allStrokes(doc, layers = DRAWABLE) {
  return layers.flatMap((id) => doc.layers[id] ?? []);
}

export class History {
  constructor(doc = createDocument(), limit = 500) {
    this.doc = doc;
    this.limit = limit;
    this.done = [];
    this.undone = [];
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }

  _push(command) {
    this.done.push(command);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  add(stroke) {
    const layer = this.doc.layers[stroke.layer];
    if (!layer) throw new Error(`cannot add a stroke to layer ${stroke.layer}`);
    layer.push(stroke);
    this._push({ type: "add", layer: stroke.layer, stroke });
  }

  /** Remove strokes (one eraser drag) as a single undoable step. */
  erase(strokes) {
    const removed = [];
    for (const stroke of strokes) {
      const list = this.doc.layers[stroke.layer];
      const index = list ? list.indexOf(stroke) : -1;
      if (index >= 0) {
        list.splice(index, 1);
        removed.push({ layer: stroke.layer, index, stroke });
      }
    }
    if (removed.length) this._push({ type: "erase", removed });
    return removed.length;
  }

  clear(layers = DRAWABLE) {
    const removed = [];
    for (const id of layers) {
      this.doc.layers[id].forEach((stroke, index) => removed.push({ layer: id, index, stroke }));
      this.doc.layers[id] = [];
    }
    if (removed.length) this._push({ type: "erase", removed });
    return removed.length;
  }

  undo() {
    const command = this.done.pop();
    if (!command) return false;
    if (command.type === "add") {
      const list = this.doc.layers[command.layer];
      list.splice(list.lastIndexOf(command.stroke), 1);
    } else {
      // Put strokes back at their old positions, lowest index first, so the stacking order is restored.
      for (const item of [...command.removed].sort((a, b) => a.index - b.index)) {
        this.doc.layers[item.layer].splice(item.index, 0, item.stroke);
      }
    }
    this.undone.push(command);
    return true;
  }

  redo() {
    const command = this.undone.pop();
    if (!command) return false;
    if (command.type === "add") {
      this.doc.layers[command.layer].push(command.stroke);
    } else {
      for (const item of command.removed) {
        const list = this.doc.layers[item.layer];
        const index = list.indexOf(item.stroke);
        if (index >= 0) list.splice(index, 1);
      }
    }
    this.done.push(command);
    return true;
  }
}
