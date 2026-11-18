// Floating panels over the paper: the toolbar buttons open and close them, so the paper keeps the whole screen.

const KEY = "drawing-room:panels";
// Panels on the right share one spot, so only one of them is open at a time. The reference card sits on its own.
const RIGHT = ["layers", "coach"];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

function store(open) {
  try { localStorage.setItem(KEY, JSON.stringify(open)); } catch { /* private mode: the panels just reset */ }
}

export function initPanels() {
  const buttons = [...document.querySelectorAll("[data-panel-toggle]")];
  const open = { reference: true, chat: true, ...load() };

  const apply = () => {
    for (const button of buttons) {
      const name = button.dataset.panelToggle;
      const panel = document.getElementById(`panel-${name}`);
      panel.hidden = !open[name];
      button.classList.toggle("active", !!open[name]);
      button.setAttribute("aria-expanded", String(!!open[name]));
    }
  };

  const setOpen = (name, value) => {
    open[name] = value;
    if (value && RIGHT.includes(name)) for (const other of RIGHT) if (other !== name) open[other] = false;
    apply();
    store(open);
  };

  for (const button of buttons) {
    button.addEventListener("click", () => setOpen(button.dataset.panelToggle, !open[button.dataset.panelToggle]));
  }
  for (const close of document.querySelectorAll("[data-panel-close]")) {
    close.addEventListener("click", () => setOpen(close.dataset.panelClose, false));
  }

  // The score shows on the toolbar button too, so it can be read with the panel closed.
  const badge = document.getElementById("score-badge");
  const shape = document.getElementById("score-shape");
  const showScore = () => {
    const value = shape.textContent.trim();
    badge.textContent = value && value !== "–" ? value : "";
    badge.hidden = !badge.textContent;
  };
  new MutationObserver(showScore).observe(shape, { childList: true, characterData: true, subtree: true });
  showScore();

  apply();
  return { open: (name) => setOpen(name, true), close: (name) => setOpen(name, false) };
}
