# Tasks Board

## In Progress
- **Bring back export, project files, paint bucket, colour picker** (PR #18, feat/restore-export-fill): lost when they were pushed after PR #5 merged.
- **Draw from a picture** (feat/draw-from-picture): Claude copies an attached picture (~90%), looks again and redraws; only Sketch/Color/Line/Notes layers; never drops strokes when 24 layers are full.

## Ready for Deploy
- **Board + README tidy-up** (PR #15, merged): fresh practice screenshots, unused pictures removed, every picture renamed so no cached old one shows, browser checks write to a temp folder on a throwaway server.
- **README rewrite** (PR #14, merged): new light-UI screenshots, a tour, Claude-as-teacher section, tools and keyboard tables.
- **Claude explains on the drawing + layer thumbnails** (PR #13, merged): real text labels and numbered steps on a "Notes" layer; layer cards zoom onto their own strokes.
- **Notes for Claude** (PR #12, merged): Note tool (N) pins numbered questions on the paper; they go with the next chat message, with their spot, and show as pins in what Claude sees.
- **Light UI, edgeless paper, grid toggle** (PR #11, merged): shadcn light theme on soft off-white paper edge to edge, draw anywhere; squared grid in paper space, toggled with the grid button or G.
- **Claude draws on layers** (PR #10, merged): perspective illustrations on Sketch / Color / Line layers with four line weights; hide Sketch for a clean box.
- **Chat pictures + composer** (PR #9, merged): attach, paste or drop pictures for Claude to look at; a tidy shadcn composer; see-through menus.
- **Dashed shapes** (PR #8, merged): a Solid / Dashed toggle in the Shapes flyout; dashes scale with the line size.
- **Board update** (PR #7, merged).
- **Toolbox + shadcn UI** (PR #6, merged): practice put away for now (free drawing; `?practice` brings it back), blank paper by default (no surprise reference line), practice menu instead of the level dropdown, left toolbox with Write (pencil, ink, marker), Paint (brush, shade, highlighter) and Shapes (line, rectangle, ellipse, triangle, diamond, arrow) flyouts with colours, a ruler that only grabs strokes running along it, layers as a fixed-width bottom strip with thumbnails that scrolls sideways, Tailwind + shadcn tokens + Lucide icons.
- **Full-screen canvas UI** (PR #5, merged): full-screen paper, paper sizes, Claude as a drawing helper on its own layer, README showcase.
- **Projects + full paper + no PIN** (PR #4, merged): server-side projects (new, open, rename, delete; autosave with a local draft), white paper across the whole drawing area (levels 3–4 score drawings anywhere), `--lan` without a PIN by default (local-network clients only), `--pin` to opt back in.
- **Pencil + tidy toolbar** (PR #3, merged): graphite pencil (pressure sets width and darkness, tilt shades), Shade tool, per-tool size and colour, one-row toolbar, compact side panel; shading is never scored.
- **Layers + ruler** (PR #2, merged): Photoshop-style layers (add, rename, reorder, hide, lock, opacity, per-layer clear and delete, ★ scored flag) and a ruler with angle snapping and typed angles.
- **drawing-room v0** (PR #1, merged): local web app for learning to draw by hand — paper canvas (pressure/tilt, layers, undo, zoom/pan/rotate, palm rejection), built-in + uploaded references, levels 0–4, deterministic scoring (`/api/score`), Claude coach (`/api/coach`), LAN mode with PIN, GELF logging.

## Deployed
