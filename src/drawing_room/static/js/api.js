// Small fetch helpers. A 401 means the server is in LAN mode and wants the PIN.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorised = () => {};
export function setUnauthorisedHandler(handler) { onUnauthorised = handler; }

async function handle(response) {
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 401) onUnauthorised();
  if (!response.ok) throw new ApiError(response.status, body?.error || `request failed (${response.status})`);
  return body;
}

export async function getJSON(path) {
  return handle(await fetch(path, { credentials: "same-origin" }));
}

export async function postJSON(path, body) {
  return handle(await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}
