---
name: pencil
description: "Generate, modify, and export visual designs (web, mobile, marketing) by describing them and operating on a live canvas. Use whenever the user asks for a design, mockup, landing page, screen, layout, or any visual asset."
---

# Pencil

Pencil renders a real interactive canvas in the user's panel. **Every op the agent makes shows up on the canvas immediately** — there's no batch mode, no spinner, no 30‑second waits. The user watches the design build.

## Tool surface

All design work goes through the **live editor** tools (provided by the bundled MCP binary, bridged to the iframe). The agent never spawns a CLI subprocess.

### Workspace navigation (4 — ours)

- `pencil_list_designs()` — every `.pen` in the workspace (workspace files + agent‑generated). Filesystem only.
- `pencil_get_active()` — which `.pen` is currently displayed in the panel. Use when the user says "this design" / "the open one".
- `pencil_open({ file? | name? })` — switch the editor panel to a different `.pen`. Workspace‑aware path resolution.
- `pencil_new({ name })` — create a brand‑new blank canvas. Sets the save target to `<workspace>/.pencil/designs/<name>.pen` and tells the editor to open a fresh empty document. After this, drive the design with `batch_design`.

### Live editor (13 — Pencil's native tools, bridged)

- **`batch_design({ operations })`** — the workhorse. Run a script of insert/copy/update/replace/move/delete/image ops in one call. ≤25 ops per batch so the user sees progress.
- **`batch_get({ patterns?, nodeIds? })`** — read nodes by ID or pattern. Use to discover structure before editing.
- **`get_editor_state({ include_schema })`** — current document, selection, and (if requested) the `.pen` schema. Call once with `include_schema: true` at the start of a task; `false` for follow‑ups.
- `get_screenshot({ nodeId })` — PNG of any node for visual verification.
- `snapshot_layout({ parentId, maxDepth?, problemsOnly? })` — compact node tree for layout reasoning.
- `find_empty_space_on_canvas({ width, height, direction, padding })` — pick a non‑overlapping region for new content.
- `open_document(filePath | "new")` — switch documents at the editor level (lower‑level than `pencil_open`; prefer `pencil_open` for existing files because it also updates the panel switcher).
- `replace_all_matching_properties` / `search_all_unique_properties` — mass property edits / discovery.
- `set_variables` / `get_variables` — design tokens.
- `export_nodes({ nodeIds, format, scale, quality? })` — render specific nodes to image files.
- **`get_guidelines(category?, name?)`** — Pencil's own `.pen` syntax + style guides. **Always call `get_guidelines("general")` once at the start of any `batch_design` work** — the op syntax is non‑obvious and these guides are how you learn it.

## Standard workflow

```text
1. get_guidelines("general")                  // load .pen op syntax
2. pencil_get_active                          // know what's open
   (or: pencil_list_designs → pencil_open / pencil_new)
3. get_editor_state({ include_schema: true }) // load document + schema
4. batch_design({ operations: [ ... ] })      // build, ≤25 ops/batch
5. get_screenshot({ nodeId })                 // verify visually
6. iterate: batch_get → batch_design → screenshot
```

## Patterns

**New design from scratch:**

```text
user: "design me an agent control center"
→ pencil_new({ name: "agent-control-center" })       // blank canvas, visible
→ get_guidelines("general")                          // .pen syntax
→ batch_design({ operations: [...frame, sidebar, header...] })  // user watches it appear
→ batch_design({ operations: [...activity feed cards...] })
→ ... continue in small batches
```

**Edit an existing design:**

```text
user: "make the title bigger"
→ get_editor_state({ include_schema: true })         // find the title node
→ batch_design({ operations: [ "U('title-id', { fontSize: 48 })" ] })  // immediate
```

**Switch context:**

```text
user: "show me the dashboard instead"
→ pencil_list_designs                                 // find it
→ pencil_open({ file: "design/dashboard.pen" })       // switch panel
```

## Behavior notes

- **Small batches.** Even though `batch_design` accepts up to 25 ops per call, prefer 5–15 — the user perceives smoother progress with more frequent updates.
- **Read before write.** Always `get_editor_state` (or `batch_get` for targeted reads) before a `batch_design` that references existing nodes. Node IDs aren't guessable.
- **Guidelines are mandatory.** `get_guidelines("general")` returns the canonical `.pen` op syntax. Skipping this leads to invalid ops and wasted batches.
- **Auth.** The live editor tools work as long as the iframe is connected — no Pencil CLI key needed. (The CLI key in the sign‑in card is only used for the editor's own cloud features like AI image gen.)
