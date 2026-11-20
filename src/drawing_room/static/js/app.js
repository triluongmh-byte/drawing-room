// The drawing room UI: paper, tools, layers, references, levels, scoring and the coach.

import { getJSON, postJSON, setUnauthorisedHandler } from "./api.js";
import { History } from "./history.js";
import { hydrateIcons, icon } from "./icons.js";
import { classifyPointer, createInputState } from "./input.js";
import {
  MAX_LAYERS, allStrokes, canDraw, createDocument, createReferenceState, getLayer, layerIndex, referenceVisible,
  restoreDocument, serializeDocument, setLayerOpacity, setReferenceOpacity, strokesForScoring,
} from "./layers.js";
import { initPanels } from "./panels.js";
import { DEFAULT_PAPER, PAPERS, drawingBounds, fitBoxes, gridLines, paperId, sheetRect } from "./paper.js";
import { settlePencil } from "./pencil.js";
import { createSaver, hasStrokes, nextProjectName, relativeTime } from "./projects.js";
import { TOOLS, cachedPath, paintStroke, strokeOpacity, strokePath } from "./render.js";
import { SHAPES, bigEnough, shapePoints } from "./shapes.js";
import { createRuler, dragEnd, followsRuler, hitHandle, moveRuler, projectOnto, restoreRuler, rulerAngle, rulerCenter, rulerLength, setAngle, snapsToRuler } from "./ruler.js";
import { addPoint, createStroke, serializeStroke, strokeBounds, strokeHits } from "./strokes.js";
import { GROUPS, clampSize, groupOf, restoreToolSettings, shareColor, stepSize } from "./tools.js";
import { MAX_NOTES, addNote, noteAt, notesSummary } from "./notes.js";
import { fitView, gestureView, pan, paperToScreen, rotateAt, screenToPaper, zoomAt } from "./view.js";

const PAPER_W = 1000;
const PAPER_H = 750;
const LEGACY_KEY = "drawing-room:v0"; // the single drawing kept in this browser before projects
const MIGRATED_KEY = "drawing-room:v0-migrated";
const DEVICE_KEY = "drawing-room:device"; // per device: the open project and each tool's size and colour
// Changes not yet on the server: written on every change, cleared once saved, so closing or reloading the
// page right after a stroke loses nothing. `base` is the server version the changes were made on.
const DRAFT_KEY = "drawing-room:draft";
const RULER_REACH = 20; // screen pixels: a stroke starting this close to the ruler may follow it...
const RULER_DECIDE = 14; // ...and once it has moved this far, it does if it runs along the ruler (ruler.js)
const HANDLE_RADIUS = 16; // screen pixels
// The practice side (levels, references, scoring) is put away for now: the app is free drawing on blank paper.
// Open the page with `?practice` to bring it back (the end-to-end checks do).
const PRACTICE = new URLSearchParams(location.search).has("practice");
const FREE_LEVEL = 2; // free drawing behaves like level 2 with no reference: Claude and the ruler on, no steps

/** What each level is called in the practice menu, and what it changes. */
const LEVEL_INFO = {
  0: { name: "Warm-up drills", icon: "dumbbell", text: "Lines, circles and ellipses between dots. Scored after every stroke." },
  1: { name: "Trace, guided", icon: "route", text: "The reference under your paper, one step at a time. Claude helps." },
  2: { name: "Trace", icon: "scan-line", text: "The reference under your paper, no steps. Claude helps when asked." },
  3: { name: "From reference", icon: "image", text: "Look at it beside the paper, nothing underneath. Proportions count, not size." },
  4: { name: "Test", icon: "graduation-cap", text: "No help at all. Press Submit and Claude reviews the drawing." },
};
const GROUP_HINTS = {
  write: "Pencil, ink and marker (P, I, M)",
  paint: "Colour brush, shade and highlighter (B, S, H)",
  shapes: "Line, rectangle, ellipse, triangle, diamond and arrow (U); hold Shift for even ones",
};
const TOOL_ICONS = { pencil: "pencil", ink: "pen-tool", marker: "pen", brush: "paintbrush", shade: "brush", highlighter: "highlighter", eraser: "eraser" };
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
// A layer with opacity below 1 is painted here first, then laid onto the paper at that opacity,
// so its own overlapping strokes do not darken each other.
const layerCanvas = document.createElement("canvas");
const layerCtx = layerCanvas.getContext("2d");

const state = {
  level: 1,
  references: [],
  reference: null, // { kind: "builtin", id, name, meta } or { kind: "upload", name, dataUrl }
  underlay: null, // HTMLImageElement drawn on the paper
  tool: "pencil",
  tools: restoreToolSettings(), // tool -> { size, color }
  groupTool: { write: "pencil", paint: "brush", shapes: "shape" }, // the tool each toolbox group picks when tapped
  shapeKind: "rect", // the shape the Shapes tool drags out (shapes.js)
  shapeDash: false, // whether shapes come out dashed
  noting: false, // the Note tool is on: a tap on the paper pins a note instead of drawing
  notes: [], // notes pinned for the next chat message: { x, y, text } in paper units
  noteDraft: null, // [x, y] of the note being written
  grid: true, // the squared grid over the paper, to line strokes up against (per device)
  flyout: null, // "write" | "paint" | "eraser" while the tool flyout is open
  attachments: [], // pictures waiting to go with the next chat message: { name, full, thumb } data URLs
  project: null, // { id, name, created, updated, strokes } of the open project
  projects: null, // the project list, as last fetched
  loading: false, // while a project is being put into the room: changes are not saves
  savedReference: null, // the reference as last sent to the server
  draftVersion: 0, // counts changes, to know whether a finished save covered the latest one
  underlayState: createReferenceState(),
  history: new History(createDocument()),
  activeLayer: "sketch",
  rulerOn: false,
  ruler: createRuler(PAPER_W / 2, PAPER_H / 2, 600, 0),
  rulerDrag: null, // { handle, start, ruler } while an end or the middle is dragged
  input: createInputState(),
  view: { x: 0, y: 0, scale: 1, rotation: 0 },
  viewFitted: false,
  current: null, // stroke being drawn
  erasing: null, // { removed: Set } during an eraser drag
  eraserAt: null,
  pointers: new Map(), // id -> { mode, x, y }
  gesture: null,
  marks: [], // miss regions from the last score, paper coordinates of the drawing
  paper: DEFAULT_PAPER, // the sheet's shape around the reference frame (paper.js)
  claudeLayer: null, // id of the layer Claude draws on, made the first time it draws
  claudeLayers: {}, // more of Claude's layers, by the name it gave them ("Chân trời", "Hộp"…) -> layer id
  chat: [], // [{ role: "user" | "assistant", text }] for the open project
  assisting: false, // waiting for Claude
  submitted: false,
  dirty: true,
};

// ------------------------------------------------------------------ persistence (per browser, best effort)

/** The open project's drawing, as saved on the server. The reference is left out unless it changed. */
function drawingPayload({ withReference = true } = {}) {
  const reference = state.reference ? { ...state.reference, meta: undefined } : null;
  return {
    level: state.level, ...serializeDocument(state.history.doc), active: state.activeLayer,
    rulerOn: state.rulerOn, ruler: state.ruler, underlayOpacity: state.underlayState.opacity,
    paper: state.paper, claudeLayer: state.claudeLayer, claudeLayers: state.claudeLayers, chat: state.chat.slice(-CHAT_KEEP),
    ...(withReference ? { reference } : {}),
  };
}

const saver = createSaver(async () => {
  const id = state.project?.id;
  if (!id) return;
  const withReference = state.reference !== state.savedReference;
  const reference = state.reference;
  const version = state.draftVersion;
  try {
    const { project } = await postJSON(`/api/projects/${id}/save`, { drawing: drawingPayload({ withReference }) });
    if (withReference) state.savedReference = reference;
    if (state.project?.id === project.id) state.project = project;
    if (state.draftVersion === version) clearDraft(); // nothing changed while saving
    $("project-status").textContent = "";
  } catch (error) {
    $("project-status").textContent = "not saved";
    $("project-status").title = `Could not save: ${error.message}. It will try again on the next change.`;
    throw error;
  }
});

function saveDevice() {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ project: state.project?.id ?? null, tools: state.tools, tool: state.tool, groupTool: state.groupTool, shapeKind: state.shapeKind, shapeDash: state.shapeDash, grid: state.grid }));
  } catch { /* private mode or full storage: drawing still works */ }
}

function loadDevice() {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || "null") ?? {}; } catch { return {}; }
}

function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* fine */ }
}

function writeDraft() {
  state.draftVersion += 1;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      id: state.project.id, base: state.project.updated,
      drawing: drawingPayload({ withReference: state.reference?.kind !== "upload" }),
    }));
  } catch { /* too big for local storage (a large upload): the server save still runs */ }
}

/** Something changed: remember this device's settings now and save the project shortly. */
function save() {
  saveDevice();
  if (state.loading || !state.project) return;
  writeDraft();
  saver.touch();
}

/** Put a saved drawing (a project's, or the old single drawing) into the room. */
function applyDrawing(saved) {
  state.history = new History(restoreDocument(saved));
  state.activeLayer = typeof saved?.active === "string" ? saved.active : "sketch";
  ensureActiveLayer();
  state.ruler = restoreRuler(saved?.ruler) ?? createRuler(PAPER_W / 2, PAPER_H / 2, 600, 0);
  state.rulerOn = saved?.rulerOn === true;
  state.underlayState = createReferenceState();
  setReferenceOpacity(state.underlayState, saved?.underlayOpacity ?? state.underlayState.opacity);
  $("opacity").value = String(state.underlayState.opacity);
  state.reference = null;
  if (!PRACTICE) { /* free drawing: whatever reference was saved stays in the file but is not shown */ }
  else if (saved?.reference?.kind === "upload" && saved.reference.dataUrl) state.reference = saved.reference;
  else if (saved?.reference?.kind === "builtin") {
    const meta = state.references.find((ref) => ref.id === saved.reference.id);
    if (meta) state.reference = { kind: "builtin", id: meta.id, name: meta.name, meta };
  }
  state.savedReference = state.reference;
  state.paper = paperId(saved?.paper);
  $("paper-size").value = state.paper;
  state.claudeLayer = typeof saved?.claudeLayer === "string" && getLayer(state.history.doc, saved.claudeLayer) ? saved.claudeLayer : null;
  state.claudeLayers = Object.fromEntries(Object.entries(saved?.claudeLayers && typeof saved.claudeLayers === "object" ? saved.claudeLayers : {})
    .filter(([name, id]) => typeof id === "string" && name.length <= 24 && getLayer(state.history.doc, id)));
  state.chat = Array.isArray(saved?.chat)
    ? saved.chat.filter((m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "assistant"))
      .map((m) => {
        // Only small picture thumbnails are kept with a message.
        const images = Array.isArray(m.images) ? m.images.filter((src) => typeof src === "string" && src.startsWith("data:image/") && src.length < 400000).slice(0, MAX_ATTACH) : [];
        return { role: m.role, text: m.text, ...(images.length ? { images } : {}) };
      }).slice(-CHAT_KEEP)
    : [];
  renderChat();
  state.marks = [];
  state.current = null;
  state.erasing = null;
  const level = !PRACTICE ? FREE_LEVEL : Number.isInteger(saved?.level) && LEVELS[saved.level] ? saved.level : 1;
  $("level").value = String(level);
  setLevel(level);
  renderLayers();
  fit();
}

// ------------------------------------------------------------------ projects

async function refreshProjects() {
  const { projects } = await getJSON("/api/projects");
  state.projects = projects;
  return projects;
}

async function openProject(id) {
  await saver.flush().catch(() => {});
  const { project, drawing } = await getJSON(`/api/projects/${id}`);
  // Unsaved changes from last time, made on the version the server still has: put them back and save them.
  const draft = readDraft();
  const recovered = draft?.id === project.id && draft.base === project.updated && draft.drawing;
  state.loading = true;
  try {
    state.project = project;
    applyDrawing(recovered ? { ...drawing, ...draft.drawing } : drawing);
  } finally {
    state.loading = false;
  }
  if (draft?.id === project.id && !recovered) clearDraft(); // made on an older version: the server has moved on
  if (recovered) { state.savedReference = undefined; save(); }
  saveDevice();
  renderProjectButton();
}

async function newProject({ name, drawing = null } = {}) {
  await saver.flush().catch(() => {});
  const projects = state.projects ?? await refreshProjects();
  // A new project keeps the level but starts on blank paper (warm-up drills pick their first drill).
  const fresh = drawing ?? { level: state.level, reference: null };
  const { project } = await postJSON("/api/projects", { name: name ?? nextProjectName(projects), drawing: fresh });
  await refreshProjects();
  await openProject(project.id);
  return project;
}

async function renameProject(name) {
  if (!state.project) return;
  const { project } = await postJSON(`/api/projects/${state.project.id}/rename`, { name });
  state.project = project;
  await refreshProjects();
  renderProjectButton();
}

async function deleteProject() {
  const project = state.project;
  if (!project || !confirm(`Delete “${project.name}” and everything drawn in it? This cannot be undone.`)) return;
  saver.cancel();
  await postJSON(`/api/projects/${project.id}/delete`, {});
  state.project = null;
  const projects = await refreshProjects();
  if (projects.length) await openProject(projects[0].id);
  else await newProject();
  flash(`Deleted “${project.name}”.`);
}

function renderProjectButton() {
  $("project-name").textContent = state.project?.name ?? "…";
  $("project-button").title = state.project ? `Project: ${state.project.name}. New, open, rename or delete.` : "Projects";
}

/** The project menu: the list (tap to open), with New, and Rename and Delete for the open project. */
function renderProjectMenu() {
  const list = $("project-list");
  list.innerHTML = "";
  for (const project of state.projects ?? []) {
    const item = document.createElement("li");
    const open = project.id === state.project?.id;
    item.classList.toggle("active", open);
    item.dataset.project = project.id;
    const name = Object.assign(document.createElement("span"), { className: "name", textContent: project.name });
    const info = Object.assign(document.createElement("span"), {
      className: "info", textContent: `${project.strokes} stroke${project.strokes === 1 ? "" : "s"} · ${relativeTime(project.updated)}`,
    });
    item.append(name, info);
    item.addEventListener("click", async () => {
      if (!open) { closeProjectMenu(); await openProject(project.id).catch((e) => flash(e.message)); }
    });
    list.append(item);
  }
  $("project-rename").value = state.project?.name ?? "";
}

async function toggleProjectMenu() {
  const menu = $("project-menu");
  if (!menu.hidden) return closeProjectMenu();
  closeModeMenu();
  if (state.flyout) setFlyout(null);
  await saver.flush().catch(() => {});
  await refreshProjects().catch(() => {});
  renderProjectMenu();
  menu.hidden = false;
  $("project-button").setAttribute("aria-expanded", "true");
}

function closeProjectMenu() {
  $("project-menu").hidden = true;
  $("project-button").setAttribute("aria-expanded", "false");
}

/** Start-up: open the device's last project, bringing over a drawing made before projects existed. */
async function startProjects() {
  const device = loadDevice();
  let projects = await refreshProjects();
  let legacy = null;
  try {
    if (!localStorage.getItem(MIGRATED_KEY)) legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
  } catch { legacy = null; }
  state.tools = restoreToolSettings(device.tools ?? legacy?.tools);
  for (const [group, { tools }] of Object.entries(GROUPS)) {
    if (tools.includes(device.groupTool?.[group])) state.groupTool[group] = device.groupTool[group];
  }
  if (SHAPES[device.shapeKind]) state.shapeKind = device.shapeKind;
  state.shapeDash = device.shapeDash === true;
  state.grid = device.grid !== false;
  renderGridToggle();
  let openId = projects.some((p) => p.id === device.project) ? device.project : projects[0]?.id;
  if (legacy && (hasStrokes(legacy) || !projects.length)) {
    const { project } = await postJSON("/api/projects", { name: hasStrokes(legacy) ? "My first drawing" : "Drawing 1", drawing: legacy });
    projects = await refreshProjects();
    openId = project.id;
  } else if (!projects.length) {
    const { project } = await postJSON("/api/projects", { name: "Drawing 1", drawing: { level: 1 } });
    projects = await refreshProjects();
    openId = project.id;
  }
  try { localStorage.setItem(MIGRATED_KEY, "1"); } catch { /* fine */ }
  await openProject(openId);
  setTool(device.tool ?? legacy?.tool ?? "pencil");
  saveDevice();
}

// ------------------------------------------------------------------ layers

function activeLayer() {
  return getLayer(state.history.doc, state.activeLayer);
}

/** After an undo or a delete the active layer may be gone: fall back to the nearest one. */
function ensureActiveLayer() {
  if (!activeLayer()) state.activeLayer = state.history.doc.layers.at(-1).id;
}

let flashTimer = null;
function flash(message) {
  const hint = $("paper-hint");
  hint.textContent = message;
  hint.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { hint.textContent = hint.dataset.text; hint.classList.remove("flash"); }, 2500);
}

function rulerEnabled() {
  return state.rulerOn && !LEVELS[state.level].drillsOnly;
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
  const [x0, y0, x1, y1] = sheetRect(state.paper);
  // Keep the sheet clear of the toolbox on the left, the chat on the right and the layers strip below.
  const left = toolboxWidth(), right = chatWidth(), bottom = layersHeight();
  const view = fitView(x1 - x0, y1 - y0, Math.max(100, rect.width - left - right), Math.max(100, rect.height - bottom));
  state.view = { ...view, x: view.x + left - x0 * view.scale, y: view.y - y0 * view.scale };
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
}

function paintLayer(layer, transform) {
  const live = state.current?.layer === layer.id && state.current.points.length;
  if (!layer.visible || layer.opacity <= 0 || (!layer.strokes.length && !live)) return;
  let target = ctx;
  if (layer.opacity < 1) {
    if (layerCanvas.width !== canvas.width || layerCanvas.height !== canvas.height) {
      layerCanvas.width = canvas.width; layerCanvas.height = canvas.height;
    }
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.clearRect(0, 0, layerCanvas.width, layerCanvas.height);
    layerCtx.setTransform(transform);
    target = layerCtx;
  }
  for (const stroke of layer.strokes) {
    if (state.erasing?.removed.has(stroke)) continue;
    paintStroke(target, stroke, cachedPath(stroke));
  }
  if (live) paintStroke(target, state.current, strokePath(state.current));
  if (target !== ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layerCanvas, 0, 0); // the paper clip on ctx still applies
    ctx.restore();
  }
}

/** The ruler: a translucent band with ticks every 10 paper pixels, round handles at the ends, a move handle in the middle. */
function drawRuler() {
  if (!rulerEnabled()) return;
  const ruler = state.ruler;
  const s = state.view.scale;
  const [ax, ay] = ruler.a, [bx, by] = ruler.b;
  const length = rulerLength(ruler);
  const ux = (bx - ax) / length, uy = (by - ay) / length;
  const nx = -uy, ny = ux;
  const band = 18 / s;
  ctx.save();
  ctx.fillStyle = "rgba(47, 111, 143, 0.13)";
  ctx.beginPath();
  ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(bx + nx * band, by + ny * band); ctx.lineTo(ax + nx * band, ay + ny * band);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(47, 111, 143, 0.9)";
  ctx.lineWidth = 1.5 / s;
  ctx.beginPath();
  ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  for (let d = 0; d <= length; d += 10) {
    const tick = d % 100 === 0 ? band * 0.75 : d % 50 === 0 ? band * 0.5 : band * 0.28;
    const px = ax + ux * d, py = ay + uy * d;
    ctx.moveTo(px, py); ctx.lineTo(px + nx * tick, py + ny * tick);
  }
  ctx.stroke();
  for (const [x, y] of [ruler.a, ruler.b]) {
    ctx.beginPath();
    ctx.arc(x, y, 9 / s, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.lineWidth = 2 / s; ctx.stroke();
  }
  const [cx, cy] = rulerCenter(ruler);
  ctx.beginPath();
  ctx.arc(cx, cy, 8 / s, 0, Math.PI * 2);
  ctx.fillStyle = "#2f6f8f"; ctx.fill();
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5 / s;
  ctx.beginPath();
  ctx.moveTo(cx - 4.5 / s, cy); ctx.lineTo(cx + 4.5 / s, cy); ctx.moveTo(cx, cy - 4.5 / s); ctx.lineTo(cx, cy + 4.5 / s);
  ctx.stroke();
  const label = `${rulerAngle(ruler)}°`;
  ctx.font = `600 ${13 / s}px -apple-system, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const lx = cx - nx * 16 / s, ly = cy - ny * 16 / s;
  const width = ctx.measureText(label).width + 10 / s;
  ctx.fillStyle = "rgba(47, 111, 143, 0.92)";
  ctx.fillRect(lx - width / 2, ly - 9 / s, width, 18 / s);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, lx, ly);
  ctx.restore();
}

// ------------------------------------------------------------------ notes pinned to ask Claude about a spot

const NOTE_COLOR = "#f0781e";

/** Numbered orange pins for the notes waiting to be sent (and the one being written), a fixed size on screen. */
function drawNotes(dpr) {
  const pins = state.notes.map((note) => [note.x, note.y]);
  if (state.noteDraft) pins.push(state.noteDraft);
  if (!pins.length) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "700 11px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  pins.forEach(([px, py], i) => {
    const [sx, sy] = paperToScreen(state.view, px, py);
    ctx.globalAlpha = i === state.notes.length ? 0.6 : 1; // the draft is faint until it is added
    ctx.beginPath();
    ctx.arc(sx, sy, 11, 0, Math.PI * 2);
    ctx.fillStyle = NOTE_COLOR;
    ctx.shadowColor = "rgba(0, 0, 0, 0.25)";
    ctx.shadowBlur = 4;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(String(i + 1), sx, sy + 0.5);
  });
  ctx.restore();
}

function setNoting(on) {
  state.noting = on;
  $("note-toggle").classList.toggle("active", on);
  $("note-toggle").setAttribute("aria-pressed", String(on));
  $("paper-wrap").classList.toggle("noting", on);
  if (!on) closeNoteEditor();
  if (on) flash("Tap a spot to ask Claude about it.");
}

function openNoteEditor([sx, sy], point) {
  if (state.notes.length >= MAX_NOTES) { flash(`Up to ${MAX_NOTES} notes per message: send these first.`); return; }
  state.noteDraft = point;
  state.dirty = true;
  const box = $("note-editor"), wrap = $("paper-wrap");
  $("note-editor-no").textContent = String(state.notes.length + 1);
  $("note-text").value = "";
  box.hidden = false;
  box.style.left = `${Math.max(8, Math.min(sx + 18, wrap.clientWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(sy - 22, wrap.clientHeight - box.offsetHeight - 8))}px`;
  $("note-text").focus();
}

function closeNoteEditor() {
  $("note-editor").hidden = true;
  if (state.noteDraft) { state.noteDraft = null; state.dirty = true; }
}

function commitNote() {
  const next = addNote(state.notes, state.noteDraft, $("note-text").value);
  if (next === state.notes) { $("note-text").focus(); return; }
  state.notes = next;
  closeNoteEditor();
  renderNotes();
  panels.open("chat");
}

function renderNotes() {
  const list = $("chat-notes");
  list.innerHTML = "";
  list.hidden = !state.notes.length;
  state.notes.forEach((note, index) => {
    const row = Object.assign(document.createElement("li"), { className: "chat-note" });
    const remove = Object.assign(document.createElement("button"), { type: "button", innerHTML: icon("x", 12), title: `Remove note ${index + 1}` });
    remove.setAttribute("aria-label", `Remove note ${index + 1}`);
    remove.addEventListener("click", () => { state.notes = state.notes.filter((_, i) => i !== index); renderNotes(); });
    row.append(Object.assign(document.createElement("span"), { className: "note-no", textContent: String(index + 1) }),
      Object.assign(document.createElement("span"), { className: "tx", textContent: note.text }), remove);
    list.append(row);
  });
  $("question").placeholder = state.notes.length ? "Anything else? Enter sends the notes too." : "Ask Claude to draw something, or for advice…";
  state.dirty = true;
}

/** The paper: a soft off-white, easier on the eyes than pure white (the top bar matches it). */
const PAPER_COLOR = "#f5f5f2";

/** The squared grid over the whole screen, in paper space, so it pans, zooms and turns with the drawing. */
function drawGrid() {
  const rect = canvas.getBoundingClientRect();
  const corners = [[0, 0], [rect.width, 0], [0, rect.height], [rect.width, rect.height]].map(([sx, sy]) => screenToPaper(state.view, sx, sy));
  const box = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))];
  const { scale } = state.view;
  const lines = gridLines(box, scale);
  ctx.lineWidth = 1 / scale;
  for (const [kind, color] of [["minor", "rgba(80, 105, 150, 0.10)"], ["major", "rgba(80, 105, 150, 0.19)"]]) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const gx of lines[kind].x) { ctx.moveTo(gx, box[1]); ctx.lineTo(gx, box[3]); }
    for (const gy of lines[kind].y) { ctx.moveTo(box[0], gy); ctx.lineTo(box[2], gy); }
    ctx.stroke();
  }
}

function setGrid(on) {
  state.grid = on;
  renderGridToggle();
  state.dirty = true;
  saveDevice();
}

function renderGridToggle() {
  $("grid-toggle").setAttribute("aria-pressed", String(state.grid));
}

function render() {
  state.dirty = false;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Off-white paper with no edge, all the way across: draw anywhere. The sheet only frames the view and what Claude sees.
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const { x, y, scale, rotation } = state.view;
  const c = Math.cos(rotation) * scale, s = Math.sin(rotation) * scale;
  ctx.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * x, dpr * y);

  ctx.save();
  if (state.grid) drawGrid();
  if (PRACTICE && state.paper !== DEFAULT_PAPER) {
    // The reference and scoring frame inside a bigger sheet (only while practising: free drawing has none).
    ctx.strokeStyle = "rgba(60, 50, 40, 0.14)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, PAPER_W, PAPER_H);
  }
  if (referenceVisible(state.underlayState) && state.underlay?.complete && state.underlay.naturalWidth) {
    ctx.globalAlpha = state.underlayState.opacity;
    ctx.drawImage(state.underlay, 0, 0, PAPER_W, PAPER_H);
    ctx.globalAlpha = 1;
  }
  for (const layer of state.history.doc.layers) paintLayer(layer, ctx.getTransform());
  drawMarks();
  ctx.restore();
  drawRuler();
  drawNotes(dpr);

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
  const layer = activeLayer();
  if (!canDraw(layer)) {
    flash(`“${layer.name}” is ${layer.locked ? "locked" : "hidden"}. Unlock or show it, or pick another layer.`);
    return;
  }
  if (state.tool === "eraser") {
    state.erasing = { removed: new Set() };
    eraseAt(px, py);
    return;
  }
  const settings = state.tools[state.tool];
  if (state.tool === "shape") {
    // Dragged out from here: the shape is rebuilt from this corner to the pointer on every move.
    state.current = createStroke({ layer: layer.id, tool: "shape", size: settings.size, opacity: TOOLS.shape.opacity, color: settings.color });
    state.current.shape = state.shapeKind;
    if (state.shapeDash) state.current.dash = true;
    state.current.shapeDrag = { a: [px, py], b: [px, py] };
    state.dirty = true;
    return;
  }
  state.current = createStroke({
    layer: layer.id, tool: state.tool, size: settings.size, opacity: TOOLS[state.tool].opacity,
    color: settings.color, simulatePressure: event.pointerType !== "pen",
  });
  // A stroke that starts against the ruler is pulled onto its edge for its whole length, but only if it then
  // runs along the ruler: one heading off across it stays freehand. Until that is clear, it follows the ruler.
  if (rulerEnabled() && snapsToRuler(state.ruler, [px, py], RULER_REACH / state.view.scale)) {
    state.current.ruled = "maybe";
    state.current.raw = [];
  }
  addEventPoint(event);
}

/** A stroke that started by the ruler: once it has moved far enough, decide whether it follows it. */
function decideRuler(stroke) {
  const first = stroke.raw[0], last = stroke.raw.at(-1);
  if (Math.hypot(last[0] - first[0], last[1] - first[1]) * state.view.scale < RULER_DECIDE) return;
  stroke.ruled = followsRuler(state.ruler, first, last);
  stroke.points = [];
  for (const [x, y, p, t, tx, ty] of stroke.raw) {
    const [qx, qy] = stroke.ruled ? projectOnto(state.ruler, [x, y]) : [x, y];
    addPoint(stroke, qx, qy, p, t, tx, ty);
  }
}

function dragShape(event) {
  const stroke = state.current;
  const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const [sx, sy] = local(events.at(-1) ?? event);
  stroke.shapeDrag.b = screenToPaper(state.view, sx, sy);
  stroke.points = [];
  for (const [x, y] of shapePoints(stroke.shape, stroke.shapeDrag.a, stroke.shapeDrag.b, { constrain: event.shiftKey })) {
    addPoint(stroke, x, y, 0.5, 0, 0, 0);
  }
  state.dirty = true;
}

function addEventPoint(event) {
  if (state.current.shapeDrag) return dragShape(event);
  const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  for (const e of events.length ? events : [event]) {
    const [sx, sy] = local(e);
    let [px, py] = screenToPaper(state.view, sx, sy);
    const pressure = e.pointerType === "pen" ? e.pressure : 0.5;
    state.current.raw?.push([px, py, pressure, e.timeStamp, e.tiltX || 0, e.tiltY || 0]);
    if (state.current.ruled) [px, py] = projectOnto(state.ruler, [px, py]);
    addPoint(state.current, px, py, pressure, e.timeStamp, e.tiltX || 0, e.tiltY || 0);
  }
  if (state.current.ruled === "maybe") decideRuler(state.current);
  // Pressure sets how dark the pencil is, and laying it flat turns the stroke into shading, while drawing.
  settlePencil(state.current);
  state.dirty = true;
}

/** The eraser is a fixed size on screen, whatever the zoom. */
function eraserRadius() {
  return state.tools.eraser.size / state.view.scale;
}

function eraseAt(px, py) {
  const radius = eraserRadius();
  for (const stroke of activeLayer().strokes) {
    if (!state.erasing.removed.has(stroke) && strokeHits(stroke, px, py, radius)) state.erasing.removed.add(stroke);
  }
  state.eraserAt = [px, py];
  state.dirty = true;
}

function finishStroke(cancel = false) {
  if (state.current) {
    const stroke = state.current;
    // A tap with the Shapes tool is not a shape.
    if (stroke.shapeDrag && !bigEnough(stroke.shapeDrag.a, stroke.shapeDrag.b)) cancel = true;
    // Working fields stay out of the saved drawing.
    if (stroke.ruled === "maybe") stroke.ruled = true; // too short to tell: it stays on the ruler
    delete stroke.raw;
    delete stroke.shapeDrag;
    if (!cancel && state.current.points.length) {
      state.history.add(settlePencil(state.current));
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
  closePopovers();
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
  if (mode === "draw" && (state.current || state.erasing || state.rulerDrag)) mode = "ignore"; // one drawing pointer at a time
  const [x, y] = local(event);
  if (mode === "draw" && state.noting) {
    // The Note tool: a tap pins a note (or shows the one already there) instead of drawing.
    const point = screenToPaper(state.view, x, y);
    const hit = noteAt(state.notes, point, 14 / state.view.scale);
    if (hit >= 0) flash(`📍${hit + 1} ${state.notes[hit].text}`);
    else openNoteEditor([x, y], point);
    return;
  }
  if (mode === "draw" && rulerEnabled()) {
    const point = screenToPaper(state.view, x, y);
    const handle = hitHandle(state.ruler, point, HANDLE_RADIUS / state.view.scale);
    if (handle) {
      mode = "ruler";
      state.rulerDrag = { handle, start: point, ruler: state.ruler };
    }
  }
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
  } else if (pointer.mode === "ruler" && state.rulerDrag) {
    const drag = state.rulerDrag;
    const [px, py] = screenToPaper(state.view, x, y);
    state.ruler = drag.handle === "move"
      ? moveRuler(drag.ruler, px - drag.start[0], py - drag.start[1])
      : dragEnd(drag.ruler, drag.handle, [px, py], { snap: !event.altKey });
    showRulerAngle();
    state.dirty = true;
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
  if (pointer.mode === "ruler") {
    state.rulerDrag = null;
    save();
  }
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
  ensureActiveLayer();
  save();
  updateButtons();
  renderLayers();
  state.dirty = true;
  if (LEVELS[state.level].guide || LEVELS[state.level].autoScore) scheduleGuide();
}

function undo() { if (state.history.undo()) { state.marks = []; afterChange(); } }
function redo() { if (state.history.redo()) { state.marks = []; afterChange(); } }

function setTool(tool) {
  if (!TOOLS[tool]) tool = "pencil";
  if (state.noting) setNoting(false);
  state.tool = tool;
  const group = groupOf(tool);
  if (group) state.groupTool[group] = tool;
  state.eraserAt = null;
  renderToolSettings();
  renderLayers();
  state.dirty = true;
}

/** The toolbox and its flyout show the current tool: its group lit, its icon, colour and size. */
function renderToolSettings() {
  const spec = TOOLS[state.tool], settings = state.tools[state.tool];
  const group = groupOf(state.tool);
  for (const button of document.querySelectorAll("#toolbox [data-group]")) {
    const name = button.dataset.group, shown = state.groupTool[name];
    button.classList.toggle("active", name === group);
    button.setAttribute("aria-expanded", String(state.flyout === name));
    button.querySelector("i[data-icon]").innerHTML = icon(toolIcon(shown), 20);
    button.querySelector(".dot").style.background = state.tools[shown].color;
    button.title = `${GROUPS[name].label}: ${toolLabel(shown)} now. ${GROUP_HINTS[name]}`;
  }
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === state.tool);
    b.setAttribute("aria-pressed", String(b.dataset.tool === state.tool));
  });
  const size = $("size");
  size.min = String(spec.min); size.max = String(spec.max);
  size.value = String(settings.size);
  $("size-value").textContent = String(settings.size);
  if (settings.color) $("color").value = settings.color;
  renderFlyout();
}

function toolIcon(tool) {
  return tool === "shape" ? SHAPES[state.shapeKind].icon : TOOL_ICONS[tool];
}

function toolLabel(tool) {
  return tool === "shape" ? SHAPES[state.shapeKind].label : TOOLS[tool].label;
}

/** The flyout beside the toolbox: the group's tools, its colours (none for the eraser) and the size. */
function renderFlyout() {
  const flyout = $("tool-flyout");
  flyout.hidden = !state.flyout;
  if (!state.flyout) return;
  const group = GROUPS[state.flyout] ?? null;
  flyout.dataset.group = state.flyout;
  $("flyout-title").textContent = group ? group.label : "Eraser";
  $("flyout-tool-name").textContent = group ? (groupOf(state.tool) === state.flyout ? toolLabel(state.tool) : "") : "whole strokes";
  const tools = $("flyout-tools");
  tools.hidden = !group;
  tools.innerHTML = "";
  // The Shapes flyout lists shapes, two rows of three; the others list their tools.
  tools.classList.toggle("flex-wrap", state.flyout === "shapes");
  if (state.flyout === "shapes") {
    for (const [kind, shape] of Object.entries(SHAPES)) {
      const on = state.tool === "shape" && kind === state.shapeKind;
      const button = document.createElement("button");
      button.className = `flyout-tool${on ? " active" : ""}`;
      button.dataset.shape = kind;
      button.setAttribute("aria-pressed", String(on));
      button.innerHTML = `${icon(shape.icon, 22)}<span>${shape.label}</span>`;
      tools.append(button);
    }
  }
  for (const tool of state.flyout === "shapes" ? [] : group?.tools ?? []) {
    const button = document.createElement("button");
    button.className = `flyout-tool${tool === state.tool ? " active" : ""}`;
    button.dataset.tool = tool;
    button.setAttribute("aria-pressed", String(tool === state.tool));
    button.innerHTML = `${icon(toolIcon(tool), 22)}<span>${toolLabel(tool)}</span>`;
    tools.append(button);
  }
  $("flyout-colors").hidden = !group;
  $("flyout-dash").hidden = state.flyout !== "shapes";
  for (const button of $("flyout-dash").querySelectorAll("[data-dash]")) {
    const on = (button.dataset.dash === "1") === state.shapeDash;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }
  const swatches = $("flyout-swatches");
  swatches.innerHTML = "";
  const current = state.tools[state.tool]?.color;
  for (const color of group?.palette ?? []) {
    const swatch = document.createElement("button");
    swatch.className = `swatch${color === current ? " active" : ""}`;
    swatch.dataset.color = color;
    swatch.style.background = color;
    swatch.title = color;
    swatch.setAttribute("aria-label", `Colour ${color}`);
    swatches.append(swatch);
  }
  // Beside the button that opened it, kept on screen.
  const opener = state.flyout === "eraser" ? $("toolbox").querySelector("[data-tool=eraser]") : $("toolbox").querySelector(`[data-group="${state.flyout}"]`);
  const wrap = $("paper-wrap").getBoundingClientRect(), at = opener.getBoundingClientRect();
  const top = Math.min(Math.max(8, at.top - wrap.top - 8), Math.max(8, wrap.height - flyout.offsetHeight - 8));
  flyout.style.top = `${top}px`;
}

function setFlyout(name) {
  state.flyout = name;
  renderToolSettings();
}

/** Tapping a group: pick its tool, or, when it is already in hand, show or hide its flyout. */
function tapGroup(name) {
  if (groupOf(state.tool) !== name) { setTool(state.groupTool[name]); save(); setFlyout(name); }
  else setFlyout(state.flyout === name ? null : name);
}

function tapEraser() {
  if (state.tool !== "eraser") { setTool("eraser"); save(); setFlyout(null); }
  else setFlyout(state.flyout === "eraser" ? null : "eraser");
}

function pickColor(color, { commit = true } = {}) {
  shareColor(state.tools, color, state.tool);
  renderToolSettings();
  if (commit) save();
}

/** Every popover (tool flyout, practice and project menus) closes on a tap elsewhere, on Escape and when drawing. */
function closePopovers() {
  if (state.flyout) setFlyout(null);
  closeModeMenu();
  closeProjectMenu();
}

function toolboxWidth() {
  const box = $("toolbox");
  return box ? box.offsetLeft + box.offsetWidth + 8 : 64;
}

/** Room taken along the bottom: the layers strip, and the chat when it is a sheet there. */
function layersHeight() {
  const bottom = $("paper-wrap").getBoundingClientRect().bottom;
  const tops = [$("panel-layers"), CHAT_SHEET.matches ? $("panel-chat") : null]
    .filter((panel) => panel && !panel.hidden).map((panel) => panel.getBoundingClientRect().top);
  return tops.length ? bottom - Math.min(...tops) + 4 : 0;
}

function setSize(value) {
  state.tools[state.tool].size = clampSize(state.tool, value);
  renderToolSettings();
  save();
}

function rotateBy(angle) {
  const rect = canvas.getBoundingClientRect();
  setView(rotateAt(state.view, rect.width / 2, rect.height / 2, angle));
}

function updateButtons() {
  $("undo").disabled = !state.history.canUndo || state.submitted;
  $("redo").disabled = !state.history.canRedo || state.submitted;
}

function iconButton(className, iconName, title, onClick, { pressed = null, disabled = false } = {}) {
  const button = document.createElement("button");
  button.className = className;
  button.innerHTML = icon(iconName, 14);
  button.title = title;
  button.setAttribute("aria-label", title);
  if (pressed !== null) button.setAttribute("aria-pressed", String(pressed));
  button.disabled = disabled;
  button.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return button;
}

function selectLayer(id) {
  if (id === state.activeLayer) return;
  state.activeLayer = id;
  save();
  renderLayers();
}

function commitRename(id, value) {
  if (state.history.renameLayer(id, value)) afterChange();
  else if (state.activeLayer !== id) renderLayers(); // another layer was picked while this name was being edited
  else { const input = $("layers").querySelector("input.name"); if (input) input.value = activeLayer().name; }
}

/** Show the active layer's name field focused and selected, ready to type a new name. */
function focusLayerName() {
  const input = $("layers").querySelector("input.name");
  if (input) { input.focus(); input.select(); }
}

// ------------------------------------------------------------------ layer thumbnails

const THUMB_W = 176, THUMB_H = 108; // device pixels of a layer card's picture (2x its CSS size)
const thumbs = new Map(); // layer id -> { key, canvas }: redrawn only when the layer's strokes or the paper change

function thumbKey(layer) {
  return `${layer.strokes.length}|${layer.strokes.at(-1)?.id ?? ""}|${layer.strokes[0]?.id ?? ""}`;
}

/** Where a stroke sits, labels included (their text, roughly). */
function strokeBox(stroke) {
  if (!stroke.text || !stroke.points.length) return strokeBounds(stroke);
  const [x, y] = stroke.points[0];
  const size = stroke.size || 18, lines = String(stroke.text).split("\n");
  const width = Math.max(...lines.map((line) => line.length)) * size * 0.58;
  const left = stroke.align === "center" ? x - width / 2 : stroke.align === "right" ? x - width : x;
  return { x0: left, y0: y - size * 0.7, x1: left + width, y1: y + size * 1.25 * lines.length };
}

let shownArea = null; // { key, area }: the sheet grown to hold every stroke, worked out again when the drawing changes

/** The sheet plus everything drawn past it, in paper units: what Claude sees. */
function drawnArea() {
  const layers = state.history.doc.layers;
  const key = `${state.paper}|${layers.map((l) => `${l.strokes.length}:${l.strokes.at(-1)?.id ?? ""}:${l.strokes[0]?.id ?? ""}`).join("|")}`;
  if (shownArea?.key !== key) shownArea = { key, area: drawingBounds(sheetRect(state.paper), allStrokes(state.history.doc).map(strokeBox)) };
  return shownArea.area;
}

/**
 * What is on the layer, as a little picture: zoomed onto that layer's own strokes (not the whole sheet, where thin
 * lines would vanish), with lines drawn at least about a pixel wide so even faint guides show.
 */
function layerThumb(layer) {
  const key = thumbKey(layer);
  const cached = thumbs.get(layer.id);
  if (cached?.key === key) return cached.canvas;
  const canvas = cached?.canvas ?? Object.assign(document.createElement("canvas"), { width: THUMB_W, height: THUMB_H });
  const g = canvas.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = PAPER_COLOR;
  g.fillRect(0, 0, THUMB_W, THUMB_H);
  const fit = fitBoxes(layer.strokes.map(strokeBox), THUMB_W, THUMB_H);
  if (fit) {
    g.setTransform(fit.scale, 0, 0, fit.scale, fit.dx, fit.dy);
    g.lineCap = g.lineJoin = "round";
    for (const stroke of layer.strokes) {
      if (stroke.fill || stroke.text || stroke.points.length < 2) { paintStroke(g, stroke, cachedPath(stroke)); continue; }
      g.globalAlpha = Math.max(0.55, strokeOpacity(stroke));
      g.strokeStyle = stroke.color || "#141312";
      g.lineWidth = Math.max(stroke.size * 0.7, 2.2 / fit.scale);
      g.beginPath();
      stroke.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.globalAlpha = 1;
    }
  }
  thumbs.set(layer.id, { key, canvas });
  return canvas;
}

function thumbCanvas(layer) {
  const canvas = Object.assign(document.createElement("canvas"), { className: "thumb", width: THUMB_W, height: THUMB_H });
  canvas.getContext("2d").drawImage(layerThumb(layer), 0, 0);
  return canvas;
}

/** The layer strip, bottom of the stack on the left; the reference underlay comes first, under everything. */
function renderLayers() {
  const list = $("layers");
  // Typing a name: do not rebuild the list under the cursor.
  if (list.contains(document.activeElement) && document.activeElement.matches("input.name")) return;
  list.innerHTML = "";
  for (const id of thumbs.keys()) if (!getLayer(state.history.doc, id)) thumbs.delete(id);

  const reference = document.createElement("li");
  reference.className = "reference-row";
  reference.hidden = !PRACTICE;
  const locked = state.underlayState.locked || !state.reference;
  const picture = state.reference
    ? Object.assign(document.createElement("img"), { className: "thumb", src: referenceUrl(false), alt: "" })
    : Object.assign(document.createElement("div"), { className: "thumb flex items-center justify-center text-muted-foreground", innerHTML: icon("file", 18) });
  if (!referenceVisible(state.underlayState) || !state.reference) picture.classList.add("opacity-35");
  const referenceRow = Object.assign(document.createElement("div"), { className: "row" });
  referenceRow.append(
    iconButton("eye", referenceVisible(state.underlayState) && state.reference ? "eye" : "eye-off",
      !state.reference ? "Blank paper: no reference" : state.underlayState.locked ? "No underlay at this level" : "Show or hide the reference underlay",
      () => { state.underlayState.visible = !state.underlayState.visible; renderLayers(); state.dirty = true; },
      { pressed: referenceVisible(state.underlayState), disabled: locked }),
    Object.assign(document.createElement("span"), { className: "name grow-1 text-muted-foreground", textContent: state.reference ? "Reference" : "Blank" }),
  );
  reference.append(picture, referenceRow);
  list.append(reference);

  for (const layer of state.history.doc.layers) {
    const item = document.createElement("li");
    const isActive = layer.id === state.activeLayer;
    item.classList.toggle("active", isActive);
    item.classList.toggle("hidden-layer", !layer.visible);
    item.dataset.layer = layer.id;
    item.title = `${layer.name}: ${layer.strokes.length} stroke${layer.strokes.length === 1 ? "" : "s"}${layer.opacity < 1 ? `, ${Math.round(layer.opacity * 100)}% opacity` : ""}`;
    // pointerdown, not click: it lands before a name field being edited loses focus and the list is rebuilt.
    item.addEventListener("pointerdown", (event) => { if (!event.target.closest("button, input")) selectLayer(layer.id); });
    let name;
    if (isActive) {
      // The active layer's name is a text field: tap it and type to rename.
      name = document.createElement("input");
      name.className = "name";
      name.value = layer.name;
      name.maxLength = 40;
      name.setAttribute("aria-label", "Layer name");
      name.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); name.blur(); }
        if (event.key === "Escape") { name.value = layer.name; name.blur(); }
      });
      name.addEventListener("blur", () => commitRename(layer.id, name.value));
    } else {
      name = Object.assign(document.createElement("span"), { className: "name", textContent: layer.name });
    }
    const eye = iconButton("eye", layer.visible ? "eye" : "eye-off", `Show or hide ${layer.name}`,
      () => { layer.visible = !layer.visible; save(); renderLayers(); state.dirty = true; }, { pressed: layer.visible });
    const lock = iconButton("lock", layer.locked ? "lock" : "lock-open", layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`,
      () => { layer.locked = !layer.locked; save(); renderLayers(); }, { pressed: layer.locked });
    const scored = iconButton("scored", "star",
      layer.scored ? `${layer.name} counts towards the score` : `${layer.name} is not scored`,
      () => { layer.scored = !layer.scored; save(); renderLayers(); }, { pressed: layer.scored });
    const count = Object.assign(document.createElement("span"), { className: "count", textContent: String(layer.strokes.length) });
    const nameRow = Object.assign(document.createElement("div"), { className: "row" });
    name.classList.add("grow-1");
    nameRow.append(name);
    const buttons = Object.assign(document.createElement("div"), { className: "row" });
    buttons.append(eye, lock, scored, count);
    item.append(thumbCanvas(layer), nameRow, buttons);
    list.append(item);
  }

  const active = activeLayer();
  const index = layerIndex(state.history.doc, active.id);
  $("layer-opacity").value = String(active.opacity);
  $("layer-opacity-value").textContent = `${Math.round(active.opacity * 100)}%`;
  $("layer-up").disabled = index >= state.history.doc.layers.length - 1;
  $("layer-down").disabled = index <= 0;
  $("layer-delete").disabled = state.history.doc.layers.length <= 1;
  $("layer-add").disabled = state.history.doc.layers.length >= MAX_LAYERS;
  $("layer-clear").disabled = !active.strokes.length;
  list.querySelector("li.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function addLayer() {
  const layer = state.history.addLayer({}, state.activeLayer);
  if (!layer) return flash(`You can have up to ${MAX_LAYERS} layers.`);
  state.activeLayer = layer.id;
  afterChange();
  focusLayerName();
}

function deleteLayer() {
  const layer = activeLayer();
  const index = layerIndex(state.history.doc, layer.id);
  if (!state.history.removeLayer(layer.id)) return;
  const layers = state.history.doc.layers;
  state.activeLayer = layers[Math.max(0, index - 1)].id;
  state.marks = [];
  afterChange();
  flash(`Deleted “${layer.name}”. Undo (⌘Z) brings it back.`);
}

function moveLayer(delta) {
  if (state.history.moveLayer(state.activeLayer, delta)) afterChange();
}

function clearLayer() {
  const layer = activeLayer();
  if (state.history.clear([layer.id])) { state.marks = []; afterChange(); }
}

// ------------------------------------------------------------------ ruler

function showRulerAngle() {
  const input = $("ruler-angle");
  if (document.activeElement !== input) input.value = String(rulerAngle(state.ruler));
}

function renderRulerControls() {
  const available = !LEVELS[state.level].drillsOnly;
  $("ruler-toggle").hidden = !available;
  $("ruler-toggle").classList.toggle("active", state.rulerOn);
  $("ruler-toggle").setAttribute("aria-pressed", String(state.rulerOn));
  $("ruler-angle-wrap").hidden = !available || !state.rulerOn;
  showRulerAngle();
}

function toggleRuler() {
  if (LEVELS[state.level].drillsOnly) return;
  state.rulerOn = !state.rulerOn;
  renderRulerControls();
  save();
  state.dirty = true;
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
  $("reference-view").hidden = !state.reference;
  $("reference-empty").hidden = !!state.reference;
  $("opacity-row").hidden = !state.reference;
  $("guide-panel").hidden = !level.guide || !state.reference; // no steps to follow on blank paper
  const guideOnly = level.underlay === "guide" && state.reference?.kind === "builtin" && state.reference.meta?.drill;
  state.underlay = state.reference ? loadImage(referenceUrl(guideOnly)) : null;
  state.marks = [];
  $("reference-mark").hidden = true;
  $("score-shape").textContent = "–";
  $("score-proportion").textContent = "–";
  $("score-detail").textContent = "";
  $("next-step").textContent = "";
  renderSteps(null);
  renderMode();
  state.dirty = true;
}

/** The reference choices for the level. Blank paper is the default everywhere but the warm-up drills. */
function fillReferenceSelect() {
  const select = $("reference");
  const drillsOnly = LEVELS[state.level].drillsOnly;
  select.innerHTML = "";
  if (!drillsOnly) select.append(new Option("Blank paper", ""));
  for (const ref of state.references) {
    if (drillsOnly && !ref.drill) continue;
    select.append(new Option(ref.drill ? `Drill: ${ref.name}` : ref.name, ref.id));
  }
  if (state.reference?.kind === "upload" && !drillsOnly) select.append(new Option(`Upload: ${state.reference.name}`, "__upload"));
  const wanted = state.reference?.kind === "upload" ? "__upload" : state.reference?.id ?? "";
  if ([...select.options].some((o) => o.value === wanted)) {
    select.value = wanted;
  } else {
    chooseBuiltin(select.options[0]?.value);
  }
}

function chooseBlank() {
  state.reference = null;
  $("reference").value = "";
  applyReference();
  renderLayers();
  save();
}

function chooseBuiltin(id) {
  const meta = state.references.find((ref) => ref.id === id);
  if (!meta) return;
  state.reference = { kind: "builtin", id, name: meta.name, meta };
  $("reference").value = id;
  applyReference();
  renderLayers();
  save();
}

// ------------------------------------------------------------------ practice menu

/** The header button: level number, its name, and what is being drawn from. */
function renderMode() {
  const info = LEVEL_INFO[state.level];
  $("mode-num").textContent = String(state.level);
  $("mode-label").textContent = info.name;
  $("mode-ref").textContent = `· ${state.reference ? state.reference.name : "Blank paper"}`;
  $("mode-button").title = `Level ${state.level}, ${info.name}: ${info.text}`;
  for (const item of $("level-list").children) {
    const on = Number(item.dataset.level) === state.level;
    item.classList.toggle("active", on);
    item.setAttribute("aria-checked", String(on));
  }
}

function buildLevelList() {
  const list = $("level-list");
  for (const [level, info] of Object.entries(LEVEL_INFO)) {
    const item = document.createElement("button");
    item.className = "level-item";
    item.dataset.level = level;
    item.setAttribute("role", "menuitemradio");
    item.innerHTML = `<span class="num">${icon(info.icon, 16)}</span><span class="flex min-w-0 flex-col gap-0.5">`
      + `<span class="text-sm font-medium">${level} · ${info.name}</span><span class="text-xs leading-snug text-muted-foreground">${info.text}</span></span>`;
    item.addEventListener("click", () => { $("level").value = level; setLevel(Number(level)); });
    list.append(item);
  }
}

function placeUnder(menu, button) {
  const at = button.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}

function toggleModeMenu() {
  const menu = $("mode-menu");
  if (!menu.hidden) return closeModeMenu();
  closePopovers();
  menu.hidden = false;
  placeUnder(menu, $("mode-button"));
  $("mode-button").setAttribute("aria-expanded", "true");
}

function closeModeMenu() {
  $("mode-menu").hidden = true;
  $("mode-button").setAttribute("aria-expanded", "false");
}

function setLevel(level) {
  state.level = level;
  const config = LEVELS[level];
  state.underlayState.locked = config.underlay === "none";
  state.submitted = false;
  $("guide-panel").hidden = !config.guide;
  $("ask-button").disabled = !config.coach || state.assisting;
  $("question").disabled = !config.coach;
  $("attach-input").disabled = !config.coach;
  $("question").placeholder = level === 0 ? "Warm-up drills are just you and the pen."
    : level === 4 ? "Claude stays quiet until you press Submit."
    : "Ask Claude to draw something, or ask for advice…";
  $("submit-button").hidden = !config.submit;
  $("score-button").hidden = config.submit;
  fillReferenceSelect();
  applyReference();
  renderLayers();
  renderRulerControls();
  renderMode();
  updateButtons();
  save();
  state.dirty = true;
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
    strokes: strokesForScoring(state.history.doc, serializeStroke),
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

const BLANK_SCORE = "Blank paper has nothing to score against. Pick a reference in the level menu at the top.";

async function scoreNow() {
  if (!state.reference) { $("score-detail").textContent = BLANK_SCORE; return null; }
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
  state.dirty = true;
}

// ------------------------------------------------------------------ chat with Claude

const CHAT_KEEP = 40; // messages kept with a project
const CLAUDE_STYLE = {
  construction: { color: "#4a90e2", size: 1.6 }, // light blue guides to draw over
  line: { color: "#26282b", size: 2.6 }, // finished lines
};

const CHAT_SHEET = window.matchMedia("(max-width: 900px) and (orientation: portrait)");

/** Room the chat takes on the right; none when it is a sheet along the bottom (portrait tablets). */
function chatWidth() {
  const chat = $("panel-chat");
  return chat && !chat.hidden && !CHAT_SHEET.matches ? chat.offsetWidth + 16 : 0;
}

function bubble(role, text, extra = "", images = []) {
  const message = Object.assign(document.createElement("div"), { className: `msg ${role} ${extra}`.trim() });
  if (images.length) {
    const row = Object.assign(document.createElement("div"), { className: "msg-images" });
    for (const src of images) row.append(Object.assign(document.createElement("img"), { src, alt: "Attached picture" }));
    message.append(row);
  }
  if (text) message.append(document.createTextNode(text));
  return message;
}

// ------------------------------------------------------------------ pictures attached to the chat

const MAX_ATTACH = 4; // per message, as the server allows
const ATTACH_SIDE = 1600; // pixels: what Claude gets
const THUMB_SIDE = 240; // pixels: what stays in the chat history

/** A picture drawn onto white, scaled to fit `side`, as a JPEG data URL. */
function scaledPicture(image, side, quality) {
  const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = Object.assign(document.createElement("canvas"), {
    width: Math.max(1, Math.round(image.naturalWidth * scale)), height: Math.max(1, Math.round(image.naturalHeight * scale)),
  });
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function readPicture(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not a picture")); };
    image.src = url;
  });
}

async function attachFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) { flash(`${file.name}: attach a picture (PNG, JPG, GIF, WebP).`); continue; }
    if (state.attachments.length >= MAX_ATTACH) { flash(`Up to ${MAX_ATTACH} pictures per message.`); break; }
    try {
      const image = await readPicture(file);
      state.attachments.push({ name: file.name, full: scaledPicture(image, ATTACH_SIDE, 0.92), thumb: scaledPicture(image, THUMB_SIDE, 0.8) });
    } catch {
      flash(`${file.name}: could not read that picture.`);
    }
  }
  renderAttachments();
  if (state.attachments.length) $("question").focus();
}

function renderAttachments() {
  const box = $("chat-attachments");
  box.innerHTML = "";
  box.hidden = !state.attachments.length;
  state.attachments.forEach((picture, index) => {
    const item = Object.assign(document.createElement("div"), { className: "attachment", title: picture.name });
    const remove = Object.assign(document.createElement("button"), { type: "button", innerHTML: icon("x", 12), title: `Remove ${picture.name}` });
    remove.setAttribute("aria-label", `Remove ${picture.name}`);
    remove.addEventListener("click", () => { state.attachments.splice(index, 1); renderAttachments(); });
    item.append(Object.assign(document.createElement("img"), { src: picture.thumb, alt: picture.name }), remove);
    box.append(item);
  });
}

/** Pictures can be pasted into the message, or dropped anywhere on the page: the chat opens to take them. */
function wireAttachments() {
  $("attach-input").addEventListener("change", (event) => { attachFiles([...event.target.files]); event.target.value = ""; });
  $("question").addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    attachFiles(files);
  });
  let depth = 0;
  const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  window.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    depth += 1;
    panels.open("chat");
    $("coach-panel").classList.add("drop");
  });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("coach-panel").classList.remove("drop"); } });
  window.addEventListener("dragover", (event) => { if (carriesFiles(event)) event.preventDefault(); });
  window.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    depth = 0;
    $("coach-panel").classList.remove("drop");
    if (!LEVELS[state.level].coach) return flash("Claude is off at this level.");
    attachFiles([...event.dataTransfer.files]);
  });
}

function renderChat(pending = null) {
  const log = $("coach-reply");
  log.innerHTML = "";
  for (const message of state.chat) log.append(bubble(message.role, message.text, "", message.images ?? []));
  if (pending) log.append(pending);
  if (!state.chat.length && !pending) {
    log.append(Object.assign(document.createElement("p"), {
      className: "chat-empty",
      textContent: "Tell Claude what to draw and it draws it for you, like a CAD helper: “draw a box in two-point "
        + "perspective”, “add a centre line”, “sketch the cap”. Draw by hand wherever you like. Blue lines are guides; "
        + "Claude's lines go on their own layer and never count in the score.",
    }));
  }
  log.scrollTop = log.scrollHeight;
}

function pushChat(role, text, images = []) {
  state.chat = [...state.chat, { role, text, ...(images.length ? { images } : {}) }].slice(-CHAT_KEEP);
  renderChat();
  save();
}

function setAssisting(busy, label = "Claude is drawing…") {
  state.assisting = busy;
  $("ask-button").disabled = busy || !LEVELS[state.level].coach;
  renderChat(busy ? bubble("assistant", label, "thinking") : null);
}

/**
 * A layer Claude draws on: "Claude" without a name, or one per name it gives ("Chân trời", "Hộp"…). Made on top of
 * the stack the first time, never scored, and found again by id afterwards (so renaming it does not make another).
 */
function ensureClaudeLayer(name = null, { busy = new Set(), emptying = new Set() } = {}) {
  const id = name ? state.claudeLayers[name] : state.claudeLayer;
  const existing = id && getLayer(state.history.doc, id);
  if (existing) return existing;
  // "Sketch" next to the person's own "Sketch" would be confusing: Claude's is "Claude Sketch".
  const taken = name && state.history.doc.layers.some((other) => other.name === name);
  const label = name ? (taken ? `Claude ${name}`.slice(0, 24) : name) : "Claude";
  let layer = state.history.addLayer({ name: label, scored: false }, state.history.doc.layers.at(-1).id);
  if (!layer) {
    // No room for another layer (24 is the most): take over one of Claude's that is empty, or about to be emptied,
    // and not used by this answer; failing that, share one of Claude's layers. Never drop the drawing.
    const mine = claudeLayerIds().map((lid) => getLayer(state.history.doc, lid));
    layer = mine.find((l) => !busy.has(l.id) && (!l.strokes.length || emptying.has(l.id)));
    if (layer) {
      state.claudeLayers = Object.fromEntries(Object.entries(state.claudeLayers).filter(([, lid]) => lid !== layer.id));
      if (state.claudeLayer === layer.id) state.claudeLayer = null;
      state.history.renameLayer(layer.id, label);
    } else {
      return mine.find((l) => busy.has(l.id)) ?? mine[0] ?? null;
    }
  }
  if (name) state.claudeLayers = { ...state.claudeLayers, [name]: layer.id };
  else state.claudeLayer = layer.id;
  return layer;
}

/** Ids of every layer Claude has drawn on that still exists. */
function claudeLayerIds() {
  return [state.claudeLayer, ...Object.values(state.claudeLayers)].filter((id) => id && getLayer(state.history.doc, id));
}

/**
 * Claude's shapes, already turned into points by the server, as ordinary strokes on its layers: ink for lines,
 * flat colour-brush areas for filled faces. Layers are made in the order the shapes first use them, lowest first.
 * `emptying` are the ids of Claude's layers this answer empties first. Returns { strokes, full } where `full` says
 * some shapes had no layer of Claude's to go on at all (24 layers, none of them Claude's).
 */
function claudeStrokes(drawn, emptying = new Set()) {
  const t0 = Math.round(performance.now());
  const strokes = [];
  const busy = new Set();
  let full = false;
  for (const shape of drawn) {
    const layer = ensureClaudeLayer(typeof shape.layer === "string" && shape.layer ? shape.layer : null, { busy, emptying });
    if (!layer) { full = true; continue; }
    busy.add(layer.id);
    const style = CLAUDE_STYLE[shape.style] ?? CLAUDE_STYLE.line;
    const opacity = Number.isFinite(shape.opacity) ? shape.opacity : 1;
    // Even, exact-width lines (the Shapes tool's pen), so Claude can tell faint guides from bold edges.
    const stroke = shape.fill
      ? createStroke({ layer: layer.id, tool: "brush", size: 1, opacity, color: shape.color ?? "#cfd8e3" })
      : createStroke({ layer: layer.id, tool: "shape", size: Number.isFinite(shape.width) ? shape.width : style.size, opacity, color: shape.color ?? style.color });
    if (typeof shape.text === "string" && shape.text) {
      // A label: real text on the drawing, its size the letter height in paper units.
      Object.assign(stroke, { text: shape.text, size: Number.isFinite(shape.size) ? shape.size : 18, align: shape.align ?? "left" });
    } else if (shape.fill) stroke.fill = true;
    else if (shape.dash) stroke.dash = true;
    shape.points.forEach(([x, y], i) => addPoint(stroke, x, y, 0.5, t0 + i, 0, 0));
    if (stroke.points.length) strokes.push(stroke);
  }
  return { strokes, full };
}

async function sendChat() {
  const text = $("question").value.trim();
  const pictures = state.attachments;
  const notes = state.notes;
  if ((!text && !pictures.length && !notes.length) || state.assisting || !LEVELS[state.level].coach) return;
  // Claude gets the conversation as text; the pictures go with this message only.
  const history = state.chat.slice(-12).map(({ role, text: said }) => ({ role, text: said }));
  $("question").value = "";
  state.attachments = [];
  renderAttachments();
  state.notes = [];
  renderNotes();
  if (state.noting) setNoting(false);
  pushChat("user", [text, notesSummary(notes)].filter(Boolean).join("\n"), pictures.map((picture) => picture.thumb));
  setAssisting(true, pictures.length ? "Claude is drawing, then checking it against your picture…" : "Claude is drawing…");
  try {
    const answer = await postJSON("/api/assist", {
      level: state.level, reference: referencePayload(), sheet: drawnArea(), message: text, history,
      attachments: pictures.map((picture) => picture.full),
      notes,
      // Claude's own strokes (on any of its layers) are marked, so it never takes them for the person's ink.
      strokes: (() => {
        const mine = new Set(claudeLayerIds());
        const byId = new Map(allStrokes(state.history.doc).map((stroke) => [stroke.id, stroke]));
        return strokesForScoring(state.history.doc, serializeStroke).map((stroke) => {
          const { fill, text, size, align } = byId.get(stroke.id) ?? {};
          return { ...stroke, assistant: mine.has(stroke.layer), ...(fill ? { fill: true } : {}), ...(text ? { text, size, align } : {}) };
        });
      })(),
    });
    let note = "";
    if (answer.strokes.length || answer.clear_previous) {
      // Starting over empties every layer of Claude's, in the same undo step as the new drawing.
      const replace = answer.clear_previous ? claudeLayerIds() : [];
      const { strokes, full } = claudeStrokes(answer.strokes, new Set(replace));
      if (strokes.length || replace.length) {
        state.history.addMany(strokes, { replace });
        afterChange();
      }
      if (full) note = " (No room for a layer of Claude's: 24 layers is the most. Delete an empty one and ask again.)";
      const hidden = [...new Set(strokes.map((stroke) => stroke.layer))].map((id) => getLayer(state.history.doc, id)).filter((layer) => !layer.visible);
      if (hidden.length) note += ` (${hidden.map((layer) => layer.name).join(", ")} ${hidden.length === 1 ? "is" : "are"} hidden: tap the eye in Layers to see ${hidden.length === 1 ? "it" : "them"}.)`;
    }
    if (answer.skipped?.length) note += ` (${answer.skipped.length} shape${answer.skipped.length === 1 ? "" : "s"} could not be drawn.)`;
    pushChat("assistant", answer.reply + note);
  } catch (error) {
    pushChat("assistant", `Claude is unavailable: ${error.message}`);
  } finally {
    setAssisting(false);
  }
}

/** The end-of-test review (level 4), answered in the chat. */
async function askCoach(question) {
  setAssisting(true, "Claude is looking at your drawing…");
  try {
    const answer = await postJSON("/api/coach", scoringBody({ question }));
    showScore(answer.score);
    if (answer.score.next_step) showNextStep(answer.score.next_step);
    state.chat = [...state.chat, { role: "assistant", text: answer.reply }].slice(-CHAT_KEEP);
  } catch (error) {
    state.chat = [...state.chat, { role: "assistant", text: `Coach unavailable: ${error.message}` }].slice(-CHAT_KEEP);
  } finally {
    setAssisting(false);
    save();
  }
}

async function submit() {
  if (!state.reference) { $("score-detail").textContent = BLANK_SCORE; return; }
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

  for (const button of $("toolbox").querySelectorAll("[data-group]")) button.addEventListener("click", () => tapGroup(button.dataset.group));
  $("toolbox").querySelector("[data-tool=eraser]").addEventListener("click", tapEraser);
  $("tool-flyout").addEventListener("click", (event) => {
    const shape = event.target.closest("[data-shape]");
    if (shape) { state.shapeKind = shape.dataset.shape; setTool("shape"); save(); return; }
    const dash = event.target.closest("[data-dash]");
    if (dash) { state.shapeDash = dash.dataset.dash === "1"; setTool("shape"); save(); return; }
    const tool = event.target.closest("[data-tool]");
    if (tool) { setTool(tool.dataset.tool); save(); return; }
    const swatch = event.target.closest("[data-color]");
    if (swatch) pickColor(swatch.dataset.color);
  });
  // Both events: some pickers (Safari on the iPad) only send `change`, when the picker closes.
  $("color").addEventListener("input", (e) => pickColor(e.target.value, { commit: false }));
  $("color").addEventListener("change", (e) => pickColor(e.target.value));
  $("size").addEventListener("input", (e) => setSize(e.target.value));
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("rotate-left").addEventListener("click", () => rotateBy(-Math.PI / 12));
  $("rotate-right").addEventListener("click", () => rotateBy(Math.PI / 12));
  $("fit").addEventListener("click", fit);
  $("clear").addEventListener("click", () => {
    if (allStrokes(state.history.doc).length && confirm("Clear every stroke on every layer? You can undo this.")) {
      state.history.clear(); state.marks = []; afterChange();
    }
  });
  $("opacity").addEventListener("input", (e) => { setReferenceOpacity(state.underlayState, e.target.value); state.dirty = true; });
  $("opacity").addEventListener("change", save);
  $("layer-add").addEventListener("click", addLayer);
  // An ordinary mouse wheel scrolls the layers strip sideways; a sideways wheel or a trackpad already does.
  $("layers").addEventListener("wheel", (event) => {
    const list = $("layers");
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || list.scrollWidth <= list.clientWidth) return;
    event.preventDefault();
    list.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 32 : 1);
  }, { passive: false });
  $("layer-delete").addEventListener("click", deleteLayer);
  $("layer-up").addEventListener("click", () => moveLayer(1));
  $("layer-down").addEventListener("click", () => moveLayer(-1));
  $("layer-clear").addEventListener("click", clearLayer);
  $("layer-opacity").addEventListener("input", (e) => {
    setLayerOpacity(activeLayer(), e.target.value);
    $("layer-opacity-value").textContent = `${Math.round(activeLayer().opacity * 100)}%`;
    state.dirty = true;
  });
  $("layer-opacity").addEventListener("change", () => { save(); renderLayers(); });
  $("ruler-toggle").addEventListener("click", toggleRuler);
  $("ruler-angle").addEventListener("change", (e) => {
    const value = Number(e.target.value);
    if (Number.isFinite(value)) { state.ruler = setAngle(state.ruler, value); save(); state.dirty = true; }
    e.target.value = String(rulerAngle(state.ruler));
  });
  $("level").addEventListener("change", (e) => setLevel(Number(e.target.value)));
  $("reference").addEventListener("change", (e) => {
    if (e.target.value === "") chooseBlank();
    else if (e.target.value !== "__upload") { chooseBuiltin(e.target.value); panels.open("reference"); }
  });
  $("mode-button").addEventListener("click", toggleModeMenu);
  $("upload").addEventListener("change", (e) => { if (e.target.files[0]) uploadReference(e.target.files[0]); e.target.value = ""; });
  $("score-button").addEventListener("click", scoreNow);
  $("submit-button").addEventListener("click", submit);
  $("next-hint").addEventListener("click", () => scheduleGuide(0));
  $("ask-button").addEventListener("click", sendChat);
  $("question").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  });
  $("grid-toggle").addEventListener("click", () => setGrid(!state.grid));
  $("note-toggle").addEventListener("click", () => setNoting(!state.noting));
  $("note-add").addEventListener("click", commitNote);
  $("note-cancel").addEventListener("click", closeNoteEditor);
  $("note-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitNote(); }
    if (e.key === "Escape") { e.preventDefault(); closeNoteEditor(); }
  });
  $("paper-size").addEventListener("change", (e) => { state.paper = paperId(e.target.value); fit(); save(); });
  $("pin-form").addEventListener("submit", sendPin);

  $("project-button").addEventListener("click", () => toggleProjectMenu().catch((e) => flash(e.message)));
  $("project-new").addEventListener("click", async () => {
    closeProjectMenu();
    try {
      await newProject();
      // Straight into naming it, like a new layer.
      await toggleProjectMenu();
      $("project-rename").focus();
      $("project-rename").select();
    } catch (error) { flash(error.message); }
  });
  $("project-rename").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); $("project-rename").blur(); }
    if (event.key === "Escape") { $("project-rename").value = state.project?.name ?? ""; $("project-rename").blur(); }
  });
  $("project-rename").addEventListener("change", async () => {
    const name = $("project-rename").value.trim();
    if (!name || name === state.project?.name) { $("project-rename").value = state.project?.name ?? ""; return; }
    try { await renameProject(name); renderProjectMenu(); } catch (error) { flash(error.message); }
  });
  $("project-delete").addEventListener("click", async () => {
    try { await deleteProject(); closeProjectMenu(); } catch (error) { flash(error.message); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!$("project-menu").hidden && !event.target.closest("#project-menu, #project-button")) closeProjectMenu();
    if (!$("mode-menu").hidden && !event.target.closest("#mode-menu, #mode-button")) closeModeMenu();
    if (state.flyout && !event.target.closest("#tool-flyout, #toolbox")) setFlyout(null);
  });
  // Save before the page goes away (the iPad suspends background tabs).
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saver.flush().catch(() => {}); });
  window.addEventListener("pagehide", () => { saver.flush().catch(() => {}); });

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("textarea, input, select")) return;
    if (e.key === "Escape") { closePopovers(); if (state.noting) setNoting(false); return; }
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === "z") { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (e.code === "Space") { state.input.spaceDown = true; e.preventDefault(); return; }
    const tools = { p: "pencil", i: "ink", m: "marker", b: "brush", s: "shade", h: "highlighter", u: "shape", e: "eraser" };
    if (tools[key]) { setTool(tools[key]); save(); }
    else if (key === "[" || key === "]") setSize(stepSize(state.tool, state.tools[state.tool].size, key === "]" ? 1 : -1));
    else if (key === "l") toggleRuler();
    else if (key === "g") setGrid(!state.grid);
    else if (key === "n" && e.shiftKey) addLayer();
    else if (key === "n") setNoting(!state.noting);
    else if (key === "r") rotateBy((e.shiftKey ? -1 : 1) * Math.PI / 12);
    else if (key === "0") fit();
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") state.input.spaceDown = false; });
}

async function start() {
  for (const [id, { name }] of Object.entries(PAPERS)) $("paper-size").append(new Option(name, id));
  $("paper-hint").dataset.text = $("paper-hint").textContent;
  setTimeout(() => $("paper-hint").classList.add("faded"), 6000);
  hydrateIcons();
  buildLevelList();
  if (!PRACTICE) {
    for (const el of [$("mode-button"), ...document.querySelectorAll('[data-panel-toggle="reference"], [data-panel-toggle="coach"]')]) {
      el.hidden = true;
      el.dataset.off = "";
    }
  }
  panels = initPanels();
  wire();
  wireAttachments();
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
  try {
    await startProjects();
  } catch (error) {
    $("coach-reply").textContent = `Could not open your projects: ${error.message}`;
  }
}

let panels = { open() {}, close() {} };

// Exposed for end-to-end tests and debugging in the console.
window.drawingRoom = { state, setTool, flush: () => saver.flush(), screenToPaper: (x, y) => screenToPaper(state.view, x, y), paperToScreen: (x, y) => paperToScreen(state.view, x, y) };

start();
