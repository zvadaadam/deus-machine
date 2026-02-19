/**
 * Draft types and conversion functions for the hive.json manifest editor.
 *
 * ManifestDraft is the local editing state — flat, array-based fields
 * that map directly to form inputs. The two conversion functions transform
 * between the raw hive.json format (nested objects) and the draft format.
 */

import { DEFAULT_TASK_ICON } from "@/shared/lib/taskIcons";

// ---------------------------------------------------------------------------
// Draft types — local editing state for the manifest
// ---------------------------------------------------------------------------

export interface TaskDraft {
  id: string;
  name: string;
  command: string;
  description: string;
  icon: string;
  persistent: boolean;
  mode: "concurrent" | "nonconcurrent";
  depends: string[];
  env: Array<{ id: string; key: string; value: string }>;
}

export interface ManifestDraft {
  version: number;
  name: string;
  setupScript: string;
  runScript: string;
  archiveScript: string;
  runScriptMode: "concurrent" | "nonconcurrent";
  requires: Array<{ id: string; tool: string; version: string }>;
  env: Array<{ id: string; key: string; value: string }>;
  tasks: TaskDraft[];
}

export const EMPTY_TASK: Omit<TaskDraft, "id"> = {
  name: "",
  command: "",
  description: "",
  icon: DEFAULT_TASK_ICON,
  persistent: false,
  mode: "concurrent",
  depends: [],
  env: [],
};

export const EMPTY_DRAFT: ManifestDraft = {
  version: 1,
  name: "",
  setupScript: "",
  runScript: "",
  archiveScript: "",
  runScriptMode: "nonconcurrent",
  requires: [],
  env: [],
  tasks: [],
};

// ---------------------------------------------------------------------------
// Conversion: raw manifest JSON ↔ editable draft
// ---------------------------------------------------------------------------

/** Convert raw manifest JSON into editable draft */
export function manifestToDraft(raw: Record<string, unknown> | null): ManifestDraft {
  if (!raw) return { ...EMPTY_DRAFT };

  const scripts = (raw.scripts as Record<string, string>) || {};
  const lifecycle = (raw.lifecycle as Record<string, string>) || {};
  const requires = (raw.requires as Record<string, string>) || {};
  const env = (raw.env as Record<string, string>) || {};
  const tasks = (raw.tasks as Record<string, unknown>) || {};

  return {
    version: (raw.version as number) || 1,
    name: (raw.name as string) || "",
    setupScript: lifecycle.setup || scripts.setup || "",
    runScript: scripts.run || "",
    archiveScript: lifecycle.archive || scripts.archive || "",
    runScriptMode: (raw.runScriptMode as "concurrent" | "nonconcurrent") || "nonconcurrent",
    requires: Object.entries(requires).map(([tool, version]) => ({ id: crypto.randomUUID(), tool, version })),
    env: Object.entries(env).map(([key, value]) => ({ id: crypto.randomUUID(), key, value })),
    tasks: Object.entries(tasks).map(([name, entry]) => {
      if (typeof entry === "string") {
        return { ...EMPTY_TASK, id: crypto.randomUUID(), name, command: entry };
      }
      const obj = entry as Record<string, unknown>;
      const taskEnv = (obj.env as Record<string, string>) || {};
      return {
        id: crypto.randomUUID(),
        name,
        command: (obj.command as string) || "",
        description: (obj.description as string) || "",
        icon: (obj.icon as string) || DEFAULT_TASK_ICON,
        persistent: (obj.persistent as boolean) || false,
        mode: (obj.mode as "concurrent" | "nonconcurrent") || "concurrent",
        depends: Array.isArray(obj.depends) ? (obj.depends as string[]) : [],
        env: Object.entries(taskEnv).map(([key, value]) => ({ id: crypto.randomUUID(), key, value })),
      };
    }),
  };
}

/** Convert draft back to hive.json manifest format */
export function draftToManifest(draft: ManifestDraft): Record<string, unknown> {
  const manifest: Record<string, unknown> = { version: draft.version };

  if (draft.name) manifest.name = draft.name;

  // Scripts
  const scripts: Record<string, string> = {};
  if (draft.setupScript) scripts.setup = draft.setupScript;
  if (draft.runScript) scripts.run = draft.runScript;
  if (Object.keys(scripts).length > 0) manifest.scripts = scripts;

  if (draft.runScriptMode !== "nonconcurrent") manifest.runScriptMode = draft.runScriptMode;

  // Lifecycle
  const lifecycle: Record<string, string> = {};
  if (draft.setupScript) lifecycle.setup = draft.setupScript;
  if (draft.archiveScript) lifecycle.archive = draft.archiveScript;
  if (Object.keys(lifecycle).length > 0) manifest.lifecycle = lifecycle;

  // Requirements
  if (draft.requires.length > 0) {
    const requires: Record<string, string> = {};
    for (const r of draft.requires) {
      if (r.tool.trim()) requires[r.tool.trim()] = r.version;
    }
    if (Object.keys(requires).length > 0) manifest.requires = requires;
  }

  // Env
  if (draft.env.length > 0) {
    const env: Record<string, string> = {};
    for (const e of draft.env) {
      if (e.key.trim()) env[e.key.trim()] = e.value;
    }
    if (Object.keys(env).length > 0) manifest.env = env;
  }

  // Tasks
  if (draft.tasks.length > 0) {
    const tasks: Record<string, unknown> = {};
    for (const t of draft.tasks) {
      if (!t.name.trim()) continue;
      if (!t.command.trim()) continue;

      // Only use string shorthand when task truly has no extra configuration
      const hasEnv = t.env.some((e) => e.key.trim());
      const hasDeps = t.depends.length > 0;
      const isSimple =
        !t.description &&
        t.icon === DEFAULT_TASK_ICON &&
        !t.persistent &&
        t.mode === "concurrent" &&
        !hasEnv &&
        !hasDeps;

      if (isSimple) {
        tasks[t.name.trim()] = t.command;
      } else {
        const entry: Record<string, unknown> = { command: t.command };
        if (t.description) entry.description = t.description;
        if (t.icon && t.icon !== DEFAULT_TASK_ICON) entry.icon = t.icon;
        if (t.persistent) entry.persistent = true;
        if (t.mode !== "concurrent") entry.mode = t.mode;
        if (hasDeps) entry.depends = t.depends;
        if (hasEnv) {
          const env: Record<string, string> = {};
          for (const e of t.env) {
            if (e.key.trim()) env[e.key.trim()] = e.value;
          }
          if (Object.keys(env).length > 0) entry.env = env;
        }
        tasks[t.name.trim()] = entry;
      }
    }
    if (Object.keys(tasks).length > 0) manifest.tasks = tasks;
  }

  return manifest;
}
