// packages/pencil/src/lib/designs.ts
//
// File-system view of designs. Two scopes:
//   1. Workspace files (<workspace>/**/*.pen) — anywhere in the user's
//      project. Discovered via a recursive scan that respects standard
//      ignore patterns (node_modules, .git, dist, etc.).
//   2. Storage files (<storage>/designs/<name>.pen) — agent-generated
//      designs default here so we don't pollute the user's repo.
//
// State files under <storage>:
//   active-pen.txt               — absolute path to the active .pen
//   cache/<hash>.preview.png     — per-design live preview cache
//   designs/<name>.pen           — agent-generated designs (legacy default)

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Design } from "./types.ts";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  ".svelte-kit",
  "__pycache__",
  ".venv",
  "venv",
]);
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_FILES = 500;

/** Restrict to filesystem-safe filenames. */
export function safePenName(name: unknown): string {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : "design";
}

/** Default save location for agent‑generated designs. We put them under
 *  `<workspace>/designs/` so they're committable to git as part of the
 *  user's repo (instead of buried in the AAP's hidden `.pencil/` storage).
 *  The `storage` arg is kept for back‑compat with old call sites that may
 *  still pass it; if the workspace is unknown we fall back to storage. */
export function penPathFor(name: string, storage: string, workspace?: string): string {
  const root = workspace ?? storage;
  return join(root, "designs", `${safePenName(name)}.pen`);
}

// ---------- active-design pointer ----------------------------------------
//
// We store the absolute path of the active .pen file. Older builds wrote
// `active-preview.txt` pointing at a .preview.png — kept readable for
// backwards compat (we strip the `.preview.png` to derive the .pen).

function activePenPointer(storage: string): string {
  return join(storage, "active-pen.txt");
}
function legacyPreviewPointer(storage: string): string {
  return join(storage, "active-preview.txt");
}

/** Set the currently-active design by absolute .pen path. */
export function setActivePen(storage: string, penPath: string): void {
  fs.mkdirSync(dirname(activePenPointer(storage)), { recursive: true });
  fs.writeFileSync(activePenPointer(storage), penPath, "utf8");
}

/** Read the active .pen path. Returns null if nothing's been opened. */
export function getActivePen(storage: string): string | null {
  try {
    const v = fs.readFileSync(activePenPointer(storage), "utf8").trim();
    if (v.length > 0) return v;
  } catch {
    /* fall through to legacy */
  }
  // Legacy: <storage>/active-preview.txt held a .preview.png path; the
  // sibling .pen is what we actually need.
  try {
    const legacy = fs.readFileSync(legacyPreviewPointer(storage), "utf8").trim();
    if (legacy.endsWith(".preview.png")) return legacy.replace(/\.preview\.png$/, ".pen");
  } catch {
    /* nothing */
  }
  return null;
}

// ---------- preview path management --------------------------------------
//
// Previews live in a content-addressed cache so .pen files anywhere in
// the workspace get a stable preview location without polluting the
// user's repo.

export function previewPathForPen(penPath: string, storage: string): string {
  // Sibling location for files inside <storage>/designs/ (back-compat with
  // the agent-generated flow); cache directory for everything else.
  if (penPath.startsWith(join(storage, "designs") + sep)) {
    return penPath.replace(/\.pen$/, ".preview.png");
  }
  const hash = createHash("sha1").update(penPath).digest("hex").slice(0, 16);
  const baseName =
    penPath
      .split("/")
      .pop()
      ?.replace(/\.pen$/, "") ?? "design";
  return join(storage, "cache", `${baseName}-${hash}.preview.png`);
}

// Legacy helpers — keep so existing code paths compile during the transition.
export function setActivePreview(storage: string, previewPath: string): void {
  setActivePen(storage, previewPath.replace(/\.preview\.png$/, ".pen"));
}
export function getActivePreview(storage: string): string | null {
  const penPath = getActivePen(storage);
  return penPath ? previewPathForPen(penPath, storage) : null;
}

// ---------- design discovery ---------------------------------------------

/** Resolve a user-supplied identifier (name OR path) to an absolute .pen
 *  path. Validates the result is somewhere safe (workspace or storage). */
export function resolvePenPath(input: string, ctx: { workspace: string; storage: string }): string {
  if (!input || typeof input !== "string") {
    throw new Error("missing path/name");
  }
  const trimmed = input.trim();
  // Absolute path: keep, but validate it's inside workspace or storage.
  if (isAbsolute(trimmed)) {
    const abs = resolve(trimmed);
    const inWorkspace = !relative(ctx.workspace, abs).startsWith("..");
    const inStorage = !relative(ctx.storage, abs).startsWith("..");
    if (!inWorkspace && !inStorage) {
      throw new Error(`path is outside the workspace: ${abs}`);
    }
    return abs;
  }
  // Relative path with separators or .pen extension: anchor at workspace.
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.endsWith(".pen")) {
    const abs = resolve(ctx.workspace, trimmed);
    if (relative(ctx.workspace, abs).startsWith("..")) {
      throw new Error(`path escapes the workspace: ${abs}`);
    }
    return abs.endsWith(".pen") ? abs : abs + ".pen";
  }
  // Bare name: agent default location (under <workspace>/designs/).
  return penPathFor(trimmed, ctx.storage, ctx.workspace);
}

/** Recursive scan of the workspace for .pen files. Respects ignore dirs,
 *  caps depth and total file count to keep large monorepos snappy. */
export function findWorkspaceDesigns(workspace: string): Design[] {
  const found: Design[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: workspace, depth: 0 }];
  while (stack.length && found.length < MAX_SCAN_FILES) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_SCAN_DEPTH) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".pencil")) continue;
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".pen")) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      found.push({
        name: e.name.slice(0, -".pen".length),
        file: full,
        preview: full.replace(/\.pen$/, ".preview.png"),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        previewExists: false,
      });
    }
  }
  found.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return found;
}

/** All designs visible to the editor: agent-generated (in storage) + any
 *  .pen files the user already has in the workspace. Workspace files are
 *  tagged as `inWorkspace: true` so the UI can group / mark them. */
export function listAllDesigns(ctx: {
  workspace: string;
  storage: string;
}): Array<Design & { inWorkspace: boolean }> {
  const storage = listStorageDesigns(ctx.storage);
  const workspace = findWorkspaceDesigns(ctx.workspace);
  // Avoid double-listing: if a workspace file is INSIDE storage (e.g.
  // workspace points at a parent containing .pencil/designs/), de-dup by
  // absolute path.
  const seen = new Set(storage.map((d) => d.file));
  const merged: Array<Design & { inWorkspace: boolean }> = [];
  for (const d of storage) merged.push({ ...d, inWorkspace: false });
  for (const d of workspace) {
    if (seen.has(d.file)) continue;
    merged.push({ ...d, inWorkspace: true });
  }
  merged.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return merged;
}

/** Just the storage scope. Kept for the legacy `pencil_list_designs` tool
 *  which the agent uses to find designs IT created. */
export function listStorageDesigns(storage: string): Design[] {
  const dir = join(storage, "designs");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Design[] = [];
  for (const name of entries) {
    if (!name.endsWith(".pen")) continue;
    const p = join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    const base = name.slice(0, -".pen".length);
    const previewSibling = join(dir, `${base}.preview.png`);
    out.push({
      name: base,
      file: p,
      preview: previewSibling,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      previewExists: fs.existsSync(previewSibling),
    });
  }
  out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return out;
}

/** Legacy: alias that points at storage-only listing. Old callers (router,
 *  mcp) still import this name. */
export const listDesigns = listStorageDesigns;
