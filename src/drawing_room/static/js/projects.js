// Projects on the client: a debounced saver, and small helpers for the project menu.
// Pure (timers are injectable), no DOM, so it can be tested with `node --test`.

/**
 * Saves at most once per `delay` ms after the last change; `flush()` saves now if anything is pending.
 * Saves never overlap: a change during a save is saved again right after it.
 */
export function createSaver(save, { delay = 1200, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  let pending = false;
  let running = null;

  async function run() {
    timer = null;
    if (running) { await running; }
    if (!pending) return;
    pending = false;
    running = (async () => { try { await save(); } finally { running = null; } })();
    await running;
    if (pending && !timer) await run();
  }

  return {
    /** Something changed: save it soon. */
    touch() {
      pending = true;
      if (timer) clearTimer(timer);
      timer = setTimer(() => { run().catch(() => {}); }, delay);
    },
    /** Save now if anything is waiting (before switching projects, or when the page is hidden). */
    async flush() {
      if (timer) { clearTimer(timer); timer = null; }
      if (running) await running;
      if (pending) await run();
    },
    /** Forget unsaved changes (the project they belong to is gone). */
    cancel() {
      if (timer) clearTimer(timer);
      timer = null;
      pending = false;
    },
    get pending() { return pending || Boolean(running); },
  };
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or a date. `when` and `now` in seconds. */
export function relativeTime(when, now = Date.now() / 1000) {
  const seconds = Math.max(0, now - when);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 86400 * 14) return `${Math.floor(seconds / 86400)} day${seconds < 86400 * 2 ? "" : "s"} ago`;
  return new Date(when * 1000).toISOString().slice(0, 10);
}

/** "Drawing N" with the lowest N (from the project count up) not already taken. */
export function nextProjectName(projects) {
  const taken = new Set(projects.map((project) => project.name.toLowerCase()));
  for (let n = projects.length + 1; ; n++) {
    if (!taken.has(`drawing ${n}`)) return `Drawing ${n}`;
  }
}

/** Whether a drawing saved by the old single-drawing version has anything worth keeping. */
export function hasStrokes(saved) {
  const layers = saved?.layers;
  if (Array.isArray(layers)) return layers.some((layer) => Array.isArray(layer?.strokes) && layer.strokes.length > 0);
  if (layers && typeof layers === "object") return Object.values(layers).some((strokes) => Array.isArray(strokes) && strokes.length > 0);
  return false;
}
