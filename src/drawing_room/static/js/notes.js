// Notes pinned on the paper to ask Claude about one spot: "is this corner right?". They wait in the chat composer
// and go out with the next message, each with its place in paper units. Pure functions, no DOM.

export const MAX_NOTES = 12; // per message, as the server allows
export const MAX_NOTE = 300; // characters

/** The list with one more note at paper point [x, y]; unchanged when the text is empty or the list is full. */
export function addNote(notes, [x, y], text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
  if (!clean || notes.length >= MAX_NOTES || !Number.isFinite(x) || !Number.isFinite(y)) return notes;
  return [...notes, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, text: clean }];
}

/** The notes as the chat shows them under the message: "📍1 text" per line. */
export function notesSummary(notes) {
  return notes.map((note, i) => `📍${i + 1} ${note.text}`).join("\n");
}

/** Index of the note whose pin is within `radius` (paper units) of [x, y], or -1. */
export function noteAt(notes, [x, y], radius) {
  let best = -1, bestDistance = radius;
  notes.forEach((note, i) => {
    const distance = Math.hypot(note.x - x, note.y - y);
    if (distance <= bestDistance) { best = i; bestDistance = distance; }
  });
  return best;
}
