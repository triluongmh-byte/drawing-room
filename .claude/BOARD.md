# Tasks Board

## In Progress
- **Toolbox + shadcn UI** (PR #6, open): practice put away for now (free drawing; `?practice` brings it back), blank paper by default (no surprise reference line), practice menu instead of the level dropdown, left toolbox with Write (pencil, ink, marker) and Paint (brush, shade, highlighter) flyouts with colours, layers as a fixed-width bottom strip with thumbnails that scrolls sideways, Tailwind + shadcn tokens + Lucide icons.

## Ready for Deploy
- **Full-screen canvas UI** (PR #5, merged): full-screen paper, paper sizes, Claude as a drawing helper on its own layer, README showcase.
- **Projects + full paper + no PIN** (PR #4, merged): server-side projects (new, open, rename, delete; autosave with a local draft), white paper across the whole drawing area (levels 3–4 score drawings anywhere), `--lan` without a PIN by default (local-network clients only), `--pin` to opt back in.
- **Pencil + tidy toolbar** (PR #3, merged): graphite pencil (pressure sets width and darkness, tilt shades), Shade tool, per-tool size and colour, one-row toolbar, compact side panel; shading is never scored.
- **Layers + ruler** (PR #2, merged): Photoshop-style layers (add, rename, reorder, hide, lock, opacity, per-layer clear and delete, ★ scored flag) and a ruler with angle snapping and typed angles.
- **drawing-room v0** (PR #1, merged): local web app for learning to draw by hand — paper canvas (pressure/tilt, layers, undo, zoom/pan/rotate, palm rejection), built-in + uploaded references, levels 0–4, deterministic scoring (`/api/score`), Claude coach (`/api/coach`), LAN mode with PIN, GELF logging.

## Deployed
