// Which pointer does what. Palm rejection: once a pen has been seen, touches never draw; they only pan and zoom.

export function createInputState() {
  return { penSeen: false, touches: 0, spaceDown: false };
}

/**
 * Decide what a new pointer does: "draw", "gesture" (touch pan/zoom), "pan" (space-drag or middle button),
 * or "ignore".
 */
export function classifyPointer(state, { pointerType, button = 0 }) {
  if (pointerType === "pen") {
    state.penSeen = true;
    return state.spaceDown ? "pan" : "draw";
  }
  if (pointerType === "touch") {
    // Without a pen, the first finger draws (finger painting); a second finger turns it into a gesture.
    if (state.penSeen || state.touches > 0) return "gesture";
    return "draw";
  }
  if (button === 1 || state.spaceDown) return "pan";
  if (button !== 0) return "ignore";
  return "draw";
}
