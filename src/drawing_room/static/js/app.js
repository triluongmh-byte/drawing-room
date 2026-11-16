// The drawing room UI: paper, tools, layers, references, levels, scoring and the coach.

import { getJSON, postJSON, setUnauthorisedHandler } from "./api.js";
import { History, allStrokes, createDocument } from "./history.js";
import { classifyPointer, createInputState } from "./input.js";
import { DRAWABLE, LAYERS, createLayerState, isVisible, layerForTool, setActive, setReferenceOpacity, toggleVisible } from "./layers.js";
import { TOOLS, cachedPath, paintStroke, strokePath } from "./render.js";
import { addPoint, createStroke, serializeStroke, strokeHits } from "./strokes.js";
import { fitView, gestureView, pan, paperToScreen, rotateAt, screenToPaper, zoomAt } from "./view.js";

const PAPER_W = 1000;
const PAPER_H = 750;
const STORAGE_KEY = "drawing-room:v0";
const LEVELS = {
  0: { underlay: "guide", coach: false, guide: false, submit: false, drillsOnly: true, autoScore: true },
  1: { underlay: "full", coach: true, guide: true, submit: false },
  2: { underlay: "full", coach: true, guide: false, submit: false },
  3: { underlay: "none", coach: true, guide: false, submit: false },
  4: { underlay: "none", coach: false, guide: false, submit: true },
};

const $ = (id) => document.getElementById(id);
const canvas = $("paper");
const ctx = canvas.getContext("2d");

const state = {
  level: 1,
  references: [],
  reference: null, // { kind: "builtin", id, name, meta } or { kind: "upload", name, dataUrl }
  underlay: null, // HTMLImageElement drawn on the paper
  tool: "pencil",
  color: "#e0604a",
  layers: createLayerState(),
  history: new History(createDocument()),
  input: createInputState(),
  view: { x: 0, y: 0, scale: 1, rotation: 0 },
  viewFitted: false,
  current: null, // stroke being drawn
  erasing: null, // { removed: Set } during an eraser drag
  eraserAt: null,
  pointers: new Map(), // id -> { mode, x, y }
  gesture: null,
  marks: [], // miss regions from the last score, paper coordinates of the drawing
  nextBox: null,
  submitted: false,
  dirty: true,
};

// ------------------------------------------------------------------ persistence (per browser, best effort)

function save() {
  try {
    const layers = Object.fromEntries(DRAWABLE.map((id) => [id, state.history.doc.layers[id]]));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ level: state.level, reference: state.reference, layers }));
  } catch { /* private mode or full storage: drawing still works */ }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved) return null;
    const doc = createDocument();
    for (const id of DRAWABLE) doc.layers[id] = Array.isArray(saved.layers?.[id]) ? saved.layers[id] : [];
    state.history = new History(doc);
    return saved;
  } catch { return null; }
}

// ------------------------------------------------------------------ rendering

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  if (!state.viewFitted) fit();
  state.dirty = true;
}

function fit() {
  const rect = canvas.getBoundingClientRect();
  state.view = fitView(PAPER_W, PAPER_H, rect.width, rect.height);
  state.viewFitted = true;
  state.dirty = true;
}

function setView(view) {
  state.view = view;
  state.dirty = true;
}

function drawMarks() {
  const lineWidth = 2.5 / state.view.scale;
  ctx.font = `${14 / state.view.scale}px -apple-system, sans-serif`;
  for (const mark of state.marks) {
    const [x0, y0, x1, y1] = mark.box;
    ctx.strokeStyle = mark.kind === "missing" ? "#e0a800" : "#f07800";
    ctx.fillStyle = mark.kind === "missing" ? "rgba(224,168,0,0.12)" : "rgba(240,120,0,0.10)";
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([8 / state.view.scale, 5 / state.view.scale]);
    ctx.fillRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12);
    ctx.strokeRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12);
    ctx.setLineDash([]);
    ctx.fillStyle = "#8a6400";
    ctx.fillText(mark.id, x0 - 4, y0 - 10);
  }
  if (state.nextBox) {
    const [x0, y0, x1, y1] = state.nextBox;
    ctx.strokeStyle = "#2f6f8f";
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([10 / state.view.scale, 6 / state.view.scale]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
  }
}

function render() {
  state.dirty = false;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { x, y, scale, rotation } = state.view;
  const c = Math.cos(rotation) * scale, s = Math.sin(rotation) * scale;
  ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * x, dpr * y);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAPER_W, PAPER_H);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PAPER_W, PAPER_H);
  ctx.clip();
  if (isVisible(state.layers, "reference") && state.underlay?.complete && state.underlay.naturalWidth) {
    ctx.globalAlpha = state.layers.referenceOpacity;
    ctx.drawImage(state.underlay, 0, 0, PAPER_W, PAPER_H);
    ctx.globalAlpha = 1;
  }
  for (const layer of DRAWABLE) {
    if (!isVisible(state.layers, layer)) continue;
    for (const stroke of state.history.doc.layers[layer]) {
      if (state.erasing?.removed.has(stroke)) continue;
      paintStroke(ctx, stroke, cachedPath(stroke));
    }
    if (state.current?.layer === layer && state.current.points.length) {
      paintStroke(ctx, state.current, strokePath(state.current));
    }
  }
  drawMarks();
  ctx.restore();

  if (state.eraserAt) {
    ctx.strokeStyle = "rgba(60,60,60,0.7)";
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    ctx.arc(state.eraserAt[0], state.eraserAt[1], eraserRadius(), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function frame() {
  if (state.dirty) render();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ pointer input

function local(event) {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function capture(event) {
  try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic events cannot be captured */ }
}

function startStroke(event) {
  const [sx, sy] = local(event);
  const [px, py] = screenToPaper(state.view, sx, sy);
  if (state.tool === "eraser") {
    state.erasing = { removed: new Set() };
    eraseAt(px, py);
    return;
  }
  const tool = TOOLS[state.tool];
  const layer = layerForTool(state.layers, state.tool);
  state.current = createStroke({
    layer, tool: state.tool, size: tool.size, opacity: tool.opacity,
    color: state.tool === "brush" ? state.color : tool.color,
    simulatePressure: event.pointerType !== "pen",
  });
  addEventPoint(event);
}

function addEventPoint(event) {
  const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  for (const e of events.length ? events : [event]) {
    const [sx, sy] = local(e);
    const [px, py] = screenToPaper(state.view, sx, sy);
    const pressure = e.pointerType === "pen" ? e.pressure : 0.5;
    addPoint(state.current, px, py, pressure, e.timeStamp, e.tiltX || 0, e.tiltY || 0);
  }
  state.dirty = true;
}

/** The eraser is a fixed size on screen, whatever the zoom. */
function eraserRadius() {
  return TOOLS.eraser.radius / state.view.scale;
}

function eraseAt(px, py) {
  const layer = state.layers.active;
  const radius = eraserRadius();
  for (const stroke of state.history.doc.layers[layer]) {
    if (!state.erasing.removed.has(stroke) && strokeHits(stroke, px, py, radius)) state.erasing.removed.add(stroke);
  }
  state.eraserAt = [px, py];
  state.dirty = true;
}

function finishStroke(cancel = false) {
  if (state.current) {
    if (!cancel && state.current.points.length) {
      state.history.add(state.current);
      afterChange();
    }
    state.current = null;
  }
  if (state.erasing) {
    if (!cancel && state.erasing.removed.size) {
      state.history.erase([...state.erasing.removed]);
      afterChange();
    }
    state.erasing = null;
    state.eraserAt = null;
  }
  state.dirty = true;
}

function gesturePoints() {
  return [...state.pointers.values()].filter((p) => p.mode === "gesture").slice(0, 2);
}

function startGesture() {
  const touches = gesturePoints();
  if (touches.length === 2) {
    state.gesture = { view: state.view, a0: [touches[0].x, touches[0].y], b0: [touches[1].x, touches[1].y], ids: touches.map((t) => t.id) };
  } else if (touches.length === 1) {
    state.gesture = { view: state.view, single: [touches[0].x, touches[0].y], ids: [touches[0].id] };
  } else {
    state.gesture = null;
  }
}

function onPointerDown(event) {
  if (state.submitted) return;
  event.preventDefault();
  if (event.pointerType === "touch") state.input.touches = [...state.pointers.values()].filter((p) => p.type === "touch").length;
  let mode = classifyPointer(state.input, event);
  if (mode === "ignore") return;
  // A second finger while the first finger is drawing: drop that stroke and switch both fingers to a gesture.
  if (event.pointerType === "touch" && mode === "gesture") {
    for (const pointer of state.pointers.values()) {
      if (pointer.type === "touch" && pointer.mode === "draw") {
        pointer.mode = "gesture";
        finishStroke(true);
      }
    }
  }
  if (mode === "draw" && (state.current || state.erasing)) mode = "ignore"; // one drawing pointer at a time
  const [x, y] = local(event);
  state.pointers.set(event.pointerId, { id: event.pointerId, type: event.pointerType, mode, x, y, last: [x, y] });
  capture(event);
  if (mode === "draw") startStroke(event);
  else if (mode === "gesture") startGesture();
}

function onPointerMove(event) {
  const pointer = state.pointers.get(event.pointerId);
  const [x, y] = local(event);
  if (!pointer) {
    if (state.tool === "eraser" && event.pointerType !== "touch") {
      state.eraserAt = screenToPaper(state.view, x, y);
      state.dirty = true;
    }
    return;
  }
  event.preventDefault();
  pointer.x = x; pointer.y = y;
  if (pointer.mode === "draw") {
    if (state.current) addEventPoint(event);
    else if (state.erasing) eraseAt(...screenToPaper(state.view, x, y));
  } else if (pointer.mode === "pan") {
    setView(pan(state.view, x - pointer.last[0], y - pointer.last[1]));
  } else if (pointer.mode === "gesture" && state.gesture) {
    const touches = state.gesture.ids.map((id) => state.pointers.get(id)).filter(Boolean);
    if (state.gesture.single && touches.length === 1) {
      const [sx, sy] = state.gesture.single;
      setView({ ...state.gesture.view, x: state.gesture.view.x + x - sx, y: state.gesture.view.y + y - sy });
    } else if (touches.length === 2) {
      setView(gestureView(state.gesture.view, state.gesture.a0, state.gesture.b0, [touches[0].x, touches[0].y], [touches[1].x, touches[1].y]));
    }
  }
  pointer.last = [x, y];
}

function onPointerUp(event) {
  const pointer = state.pointers.get(event.pointerId);
  if (!pointer) return;
  state.pointers.delete(event.pointerId);
  if (pointer.mode === "draw") finishStroke(event.type === "pointercancel");
  if (pointer.mode === "gesture") startGesture();
}

function onWheel(event) {
  event.preventDefault();
  const [x, y] = local(event);
  if (event.altKey) {
    setView(rotateAt(state.view, x, y, event.deltaY * 0.003));
  } else if (event.ctrlKey || event.metaKey || event.deltaMode === 1 || Math.abs(event.deltaY) >= 50 && event.deltaX === 0) {
    // Trackpad pinch (ctrlKey) and mouse wheels zoom.
    setView(zoomAt(state.view, x, y, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))));
  } else {
    // Two-finger trackpad scroll pans.
    setView(pan(state.view, -event.deltaX, -event.deltaY));
  }
}

// ------------------------------------------------------------------ actions

function afterChange() {
  save();
  updateButtons();
  renderLayers();
  if (LEVELS[state.level].guide || LEVELS[state.level].autoScore) scheduleGuide();
}

function undo() { if (state.history.undo()) { state.marks = []; afterChange(); state.dirty = true; } }
function redo() { if (state.history.redo()) { state.marks = []; afterChange(); state.dirty = true; } }

function setTool(tool) {
  state.tool = tool;
  if (tool !== "eraser") setActive(state.layers, layerForTool(state.layers, tool));
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  state.eraserAt = null;
  renderLayers();
  state.dirty = true;
}

function rotateBy(angle) {
  const rect = canvas.getBoundingClientRect();
  setView(rotateAt(state.view, rect.width / 2, rect.height / 2, angle));
}

function updateButtons() {
  $("undo").disabled = !state.history.canUndo || state.submitted;
  $("redo").disabled = !state.history.canRedo || state.submitted;
}

function renderLayers() {
  const list = $("layers");
  list.innerHTML = "";
  for (const layer of LAYERS) {
    const item = document.createElement("li");
    item.classList.toggle("active", layer.id === state.layers.active);
    const eye = document.createElement("button");
    eye.className = "eye";
    const locked = layer.id === "reference" && state.layers.referenceLocked;
    eye.textContent = isVisible(state.layers, layer.id) ? "👁" : "–";
    eye.title = locked ? "No underlay at this level" : `Show or hide ${layer.name}`;
    eye.disabled = locked;
    eye.addEventListener("click", () => { toggleVisible(state.layers, layer.id); renderLayers(); state.dirty = true; });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = layer.name;
    if (layer.drawable) name.addEventListener("click", () => { setActive(state.layers, layer.id); renderLayers(); });
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = layer.drawable ? `${state.history.doc.layers[layer.id].length}` : (locked ? "off" : "");
    item.append(eye, name, count);
    list.append(item);
  }
}

// ------------------------------------------------------------------ references and levels

function referencePayload() {
  if (!state.reference) return null;
  return state.reference.kind === "builtin" ? { id: state.reference.id } : { image: state.reference.dataUrl, name: state.reference.name };
}

function referenceUrl(guide = false) {
  if (!state.reference) return "";
  return state.reference.kind === "builtin" ? `/api/references/${state.reference.id}.png${guide ? "?guide=1" : ""}` : state.reference.dataUrl;
}

function loadImage(src) {
  const image = new Image();
  image.onload = () => { state.dirty = true; };
  image.src = src;
  return image;
}

function applyReference() {
  const level = LEVELS[state.level];
  $("reference-image").src = referenceUrl(false);
  const guideOnly = level.underlay === "guide" && state.reference?.kind === "builtin" && state.reference.meta?.drill;
  state.underlay = state.reference ? loadImage(referenceUrl(guideOnly)) : null;
  state.marks = [];
  state.nextBox = null;
  $("reference-mark").hidden = true;
  $("score-shape").textContent = "–";
  $("score-proportion").textContent = "–";
  $("score-detail").textContent = "";
  $("next-step").textContent = "";
  renderSteps(null);
  state.dirty = true;
}

function fillReferenceSelect() {
  const select = $("reference");
  const drillsOnly = LEVELS[state.level].drillsOnly;
  select.innerHTML = "";
  for (const ref of state.references) {
    if (drillsOnly && !ref.drill) continue;
    select.append(new Option(ref.drill ? `Drill: ${ref.name}` : ref.name, ref.id));
  }
  if (state.reference?.kind === "upload" && !drillsOnly) select.append(new Option(`Upload: ${state.reference.name}`, "__upload"));
  const wanted = state.reference?.kind === "upload" ? "__upload" : state.reference?.id;
  if ([...select.options].some((o) => o.value === wanted)) {
    select.value = wanted;
  } else {
    chooseBuiltin(select.options[0]?.value);
  }
}

function chooseBuiltin(id) {
  const meta = state.references.find((ref) => ref.id === id);
  if (!meta) return;
  state.reference = { kind: "builtin", id, name: meta.name, meta };
  $("reference").value = id;
  applyReference();
  save();
}

function setLevel(level) {
  state.level = level;
  const config = LEVELS[level];
  state.layers.referenceLocked = config.underlay === "none";
  state.submitted = false;
  $("guide-panel").hidden = !config.guide;
  $("ask-button").disabled = !config.coach;
  $("question").disabled = !config.coach;
  $("coach-panel").hidden = level === 0;
  $("submit-button").hidden = !config.submit;
  $("score-button").hidden = config.submit;
  $("coach-reply").textContent = level === 4 ? "The coach stays quiet until you press Submit." : "";
  fillReferenceSelect();
  applyReference();
  renderLayers();
  updateButtons();
  save();
  if (config.guide) scheduleGuide(0);
}

/** Letterbox an uploaded image onto a paper-sized white PNG, so what is shown is exactly what is scored. */
function uploadReference(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const paper = document.createElement("canvas");
      paper.width = PAPER_W; paper.height = PAPER_H;
      const g = paper.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, PAPER_W, PAPER_H);
      const scale = Math.min(PAPER_W / image.width, PAPER_H / image.height);
      const w = image.width * scale, h = image.height * scale;
      g.drawImage(image, (PAPER_W - w) / 2, (PAPER_H - h) / 2, w, h);
      state.reference = { kind: "upload", name: file.name.slice(0, 60), dataUrl: paper.toDataURL("image/png") };
      if (LEVELS[state.level].drillsOnly) $("level").value = "1";
      setLevel(Number($("level").value));
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ------------------------------------------------------------------ scoring, guide and coach

function scoringBody(extra = {}) {
  return {
    level: state.level,
    reference: referencePayload(),
    strokes: allStrokes(state.history.doc).map(serializeStroke),
    ...extra,
  };
}

function showScore(result) {
  $("score-shape").textContent = result.shape.toFixed(1);
  $("score-proportion").textContent = result.proportion.toFixed(1);
  const parts = [`covered ${Math.round(result.recall * 100)}% of the reference`,
    `${Math.round(result.precision * 100)}% of your ink on it`];
  if (result.aligned) parts.push("size and position ignored");
  if (result.stats.stroke_count) parts.push(`${result.stats.stroke_count} strokes, ${Math.round(result.stats.short_share * 100)}% short`);
  $("score-detail").textContent = parts.join(" · ");
  state.marks = [...result.misses, ...result.strays];
  state.dirty = true;
}

async function scoreNow() {
  if (!state.reference) return null;
  $("score-button").disabled = true;
  try {
    const result = await postJSON("/api/score", scoringBody());
    showScore(result);
    if (result.next_step) showNextStep(result.next_step);
    return result;
  } catch (error) {
    $("score-detail").textContent = error.message;
    return null;
  } finally {
    $("score-button").disabled = false;
  }
}

let guideTimer = null;
function scheduleGuide(delay = 700) {
  clearTimeout(guideTimer);
  guideTimer = setTimeout(async () => {
    const level = LEVELS[state.level];
    if (!(level.guide || level.autoScore) || !state.reference) return;
    try {
      const result = await postJSON("/api/score", scoringBody());
      // Warm-up drills are scored automatically after every stroke.
      if (level.autoScore && allStrokes(state.history.doc).length) showScore(result);
      if (result.next_step) showNextStep(result.next_step);
    } catch { /* the guide is a nicety; the Score button reports errors */ }
  }, delay);
}

function renderSteps(next) {
  const list = $("steps");
  list.innerHTML = "";
  const steps = state.reference?.kind === "builtin" ? state.reference.meta.steps : [];
  steps.forEach((step, index) => {
    const item = document.createElement("li");
    item.textContent = step.text;
    if (next && next.index !== null && index < next.index) item.classList.add("done");
    if (next && next.index === index) item.classList.add("current");
    list.append(item);
  });
}

function showNextStep(next) {
  renderSteps(next);
  $("next-step").textContent = next.text;
  state.nextBox = next.box;
  const mark = $("reference-mark");
  if (next.box) {
    const [x0, y0, x1, y1] = next.box;
    Object.assign(mark.style, { left: `${(x0 / PAPER_W) * 100}%`, top: `${(y0 / PAPER_H) * 100}%`,
      width: `${((x1 - x0) / PAPER_W) * 100}%`, height: `${((y1 - y0) / PAPER_H) * 100}%` });
    mark.hidden = false;
  } else {
    mark.hidden = true;
  }
  state.dirty = true;
}

async function askCoach(question) {
  const reply = $("coach-reply");
  reply.innerHTML = '<span class="thinking">The coach is looking at your drawing…</span>';
  $("ask-button").disabled = true;
  try {
    const answer = await postJSON("/api/coach", scoringBody({ question }));
    reply.textContent = answer.reply;
    showScore(answer.score);
    if (answer.score.next_step) showNextStep(answer.score.next_step);
  } catch (error) {
    reply.innerHTML = "";
    const span = document.createElement("span");
    span.className = "error";
    span.textContent = `Coach unavailable: ${error.message}`;
    reply.append(span);
  } finally {
    $("ask-button").disabled = !LEVELS[state.level].coach;
  }
}

async function submit() {
  state.submitted = true;
  updateButtons();
  $("submit-button").disabled = true;
  await askCoach("I have finished. Please review my drawing.");
  $("submit-button").disabled = false;
  state.submitted = false;
  updateButtons();
}

// ------------------------------------------------------------------ PIN

function showPin() {
  $("pin-overlay").hidden = false;
  $("pin-input").focus();
}

async function sendPin(event) {
  event.preventDefault();
  try {
    await postJSON("/api/pin", { pin: $("pin-input").value });
    location.reload();
  } catch (error) {
    $("pin-error").textContent = error.message;
  }
}

// ------------------------------------------------------------------ wiring

function wire() {
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", () => { if (!state.pointers.size && state.eraserAt) { state.eraserAt = null; state.dirty = true; } });
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // Safari's own pinch gestures would zoom the page instead of the paper.
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(name, (e) => e.preventDefault());
  document.addEventListener("touchmove", (e) => { if (e.target === canvas) e.preventDefault(); }, { passive: false });
  window.addEventListener("resize", resize);

  document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("color").addEventListener("input", (e) => { state.color = e.target.value; });
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("rotate-left").addEventListener("click", () => rotateBy(-Math.PI / 12));
  $("rotate-right").addEventListener("click", () => rotateBy(Math.PI / 12));
  $("fit").addEventListener("click", fit);
  $("clear").addEventListener("click", () => {
    if (allStrokes(state.history.doc).length && confirm("Clear every stroke? You can undo this.")) {
      state.history.clear(); state.marks = []; afterChange(); state.dirty = true;
    }
  });
  $("opacity").addEventListener("input", (e) => { setReferenceOpacity(state.layers, e.target.value); state.dirty = true; });
  $("level").addEventListener("change", (e) => setLevel(Number(e.target.value)));
  $("reference").addEventListener("change", (e) => { if (e.target.value !== "__upload") chooseBuiltin(e.target.value); });
  $("upload").addEventListener("change", (e) => { if (e.target.files[0]) uploadReference(e.target.files[0]); e.target.value = ""; });
  $("score-button").addEventListener("click", scoreNow);
  $("submit-button").addEventListener("click", submit);
  $("next-hint").addEventListener("click", () => scheduleGuide(0));
  $("ask-button").addEventListener("click", () => askCoach($("question").value));
  $("pin-form").addEventListener("submit", sendPin);

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("textarea, input, select")) return;
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === "z") { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (e.code === "Space") { state.input.spaceDown = true; e.preventDefault(); return; }
    const tools = { p: "pencil", i: "ink", b: "brush", e: "eraser" };
    if (tools[key]) setTool(tools[key]);
    else if (key === "r") rotateBy((e.shiftKey ? -1 : 1) * Math.PI / 12);
    else if (key === "0") fit();
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") state.input.spaceDown = false; });
}

async function start() {
  wire();
  setUnauthorisedHandler(showPin);
  resize();
  requestAnimationFrame(frame);
  try {
    const session = await getJSON("/api/session");
    if (session.pin_required && !session.authorised) return showPin();
    const { references } = await getJSON("/api/references");
    state.references = references;
  } catch (error) {
    $("coach-reply").textContent = `Could not reach the server: ${error.message}`;
    return;
  }
  const saved = load();
  if (saved?.reference?.kind === "upload" && saved.reference.dataUrl) state.reference = saved.reference;
  else if (saved?.reference?.kind === "builtin") {
    const meta = state.references.find((ref) => ref.id === saved.reference.id);
    if (meta) state.reference = { kind: "builtin", id: meta.id, name: meta.name, meta };
  }
  const level = Number.isInteger(saved?.level) ? saved.level : 1;
  $("level").value = String(level);
  setTool("pencil");
  setLevel(level);
}

// Exposed for end-to-end tests and debugging in the console.
window.drawingRoom = { state, screenToPaper: (x, y) => screenToPaper(state.view, x, y), paperToScreen: (x, y) => paperToScreen(state.view, x, y) };

start();
