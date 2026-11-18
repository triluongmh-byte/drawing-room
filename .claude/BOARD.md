# Tasks Board

## Backlog
- **Claude co-op in SVG**: Claude draws flat-vector illustrations (filled shapes, gradients, opacity) as SVG on the Claude layer, and edits that SVG in place for follow-ups ("make the lanterns blue") instead of redrawing. Rendered as an image (no scripts, no external loads), one undo per edit, included in PNG/JPG export, never scored. Also send the reference's bounding box in paper units so Claude places things over it, not beside it. Expect 1–2 min per big scene; the stroke eraser cannot erase inside the SVG.
- **Pencil darkness per point**: opacity follows pressure along the stroke (today it is one value per stroke from the median), so flicked lines fade out at the ends like graphite.
- **Perspective guides**: one or two vanishing points that strokes snap towards, like the ruler.
- **Partial eraser**: erase part of a stroke, or lighten it, instead of removing whole strokes.
- **Coach language**: the coach prompt forces plain English; decide with 31803smith whether it should answer in the person's language and tone like the chat does.

## In Progress
- **Full-screen canvas UI** (branch `feat/fullscreen-canvas-ui`, PR not opened yet): slim top bar, floating glass panels, paper sizes on a grid desk, Claude chat docked on the right that draws on a Claude layer, shared colour, PNG/JPG export, project files (save/open), save status, paint bucket, basic shapes (line, rectangle, ellipse, triangle), chat matches the person's tone and knows the score and its M/S regions.

## Ready for Deploy
- **Projects + full paper + no PIN** (PR #4, merged): server-side projects (new, open, rename, delete; autosave with a local draft), white paper across the whole drawing area (levels 3–4 score drawings anywhere), `--lan` without a PIN by default (local-network clients only), `--pin` to opt back in.
- **Pencil + tidy toolbar** (PR #3, merged): graphite pencil (pressure sets width and darkness, tilt shades), Shade tool, per-tool size and colour, one-row toolbar, compact side panel; shading is never scored.
- **Layers + ruler** (PR #2, merged): Photoshop-style layers (add, rename, reorder, hide, lock, opacity, per-layer clear and delete, ★ scored flag) and a ruler with angle snapping and typed angles.
- **drawing-room v0** (PR #1, merged): local web app for learning to draw by hand — paper canvas (pressure/tilt, layers, undo, zoom/pan/rotate, palm rejection), built-in + uploaded references, levels 0–4, deterministic scoring (`/api/score`), Claude coach (`/api/coach`), LAN mode with PIN, GELF logging.

## Deployed
