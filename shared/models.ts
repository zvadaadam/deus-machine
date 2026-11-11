// shared/models.ts
// The models a chat can run, and what Deus itself chooses.
//
// Deus keeps no list of models. The engine (@zvada/agent-server) lists them,
// in one shape for every harness: for a local chat, as the user's own CLI
// offers them for their login and folder (`q:request agentModels`); for a
// cloud chat, as the platform lists them (`q:request cloudModels`, the same
// engine's catalog). Before an answer arrives, and when none can, a picker
// shows the catalog the embedded engine was built with.
//
// What is Deus's own stays here: the names it shows for the harnesses, and the
// model and thinking level a new chat starts on.

import {
  CATALOG_MODELS,
  THINKING_LEVELS,
  clampThinkingLevel,
  type ModelDescriptor,
  type ModelList,
  type ThinkingLevel,
} from "@zvada/agent-server/protocol";
import { LOCAL_HARNESSES, type LocalHarness } from "./agent-auth";
import { AgentHarnessSchema, type AgentHarness } from "./enums";

export type { ModelDescriptor, ModelList };

/** One harness's models: the part of a list a picker reads. */
export interface HarnessModels {
  readonly harness: string;
  readonly models: readonly ModelDescriptor[];
}

/** `q:request agentModels`: each local harness's list, as the engine has it. */
export interface AgentModelsAnswer {
  lists: ModelList[];
}

// ── What Deus chooses ──────────────────────────────────────────────────────

/** The harnesses a picker groups its models under, in order. */
export const PICKER_HARNESSES: readonly LocalHarness[] = LOCAL_HARNESSES;

/** The name each harness is shown under. */
export const HARNESS_LABELS: Record<AgentHarness, string> = {
  "claude-code": "Claude Code",
  "codex-sdk": "Codex SDK",
  "codex-app-server": "Codex",
};

export const DEFAULT_AGENT_HARNESS = "claude-code" satisfies AgentHarness;
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

/**
 * The models Deus prefers for a new chat, best first. The first one a list
 * offers is used; a harness with none takes its own default. These are the
 * vendor's aliases, so the choice follows its newest model (Opus 5.5 today).
 */
const PREFERRED_MODELS: Record<LocalHarness, readonly string[]> = {
  "claude-code": ["opus"],
  "codex-app-server": [],
};

// ── Lists ──────────────────────────────────────────────────────────────────

/** Claude's alias for whatever the account's default is: not a row a chat picks. */
const ACCOUNT_DEFAULT_MODEL = "default";

/** The lists the embedded engine was built with. */
export const CATALOG_MODEL_LISTS: readonly HarnessModels[] = LOCAL_HARNESSES.map((harness) => ({
  harness,
  models: CATALOG_MODELS.filter((model) => model.harness === harness),
}));

/** A legacy harness's models are the ones its successor lists. */
function listedHarness(harness: string): string {
  return harness === "codex-sdk" ? "codex-app-server" : harness;
}

function allModels(lists: readonly HarnessModels[], harness: string): readonly ModelDescriptor[] {
  return lists.find((list) => list.harness === listedHarness(harness))?.models ?? [];
}

/** The rows a picker offers for `harness`, in the list's order. */
export function pickerModels(
  lists: readonly HarnessModels[],
  harness: string
): readonly ModelDescriptor[] {
  return allModels(lists, harness).filter((model) => model.id !== ACCOUNT_DEFAULT_MODEL);
}

/** The context window a Claude model id may ask for: `claude-opus-5[1m]`. */
const WINDOW_SUFFIX = /\[(\d+[km])\]$/i;

/**
 * The row for `model`, and the window it asks for when it is a variant of a
 * listed model (`…[1m]`): a list names the model, not each window it runs.
 */
export function findModel(
  lists: readonly HarnessModels[],
  harness: string,
  model: string
): { row: ModelDescriptor; window?: string } | undefined {
  const models = allModels(lists, harness);
  const row = models.find((listed) => listed.id === model);
  if (row) return { row };
  const window = WINDOW_SUFFIX.exec(model)?.[1];
  if (!window) return undefined;
  const base = models.find((listed) => listed.id === model.replace(WINDOW_SUFFIX, ""));
  return base ? { row: base, window: window.toUpperCase() } : undefined;
}

/** What a model is shown as: its listed label, else its id. */
export function modelLabel(
  lists: readonly HarnessModels[],
  harness: string,
  model: string
): string {
  const found = findModel(lists, harness, model);
  if (!found) return model;
  return found.window ? `${found.row.label} ${found.window}` : found.row.label;
}

/**
 * The thinking levels a chat on `model` chooses from, lowest first; none for a
 * model with no thinking control. A model no list names (an older chat's)
 * gets every level its harness lists: the engine runs the nearest one.
 */
export function modelThinkingLevels(
  lists: readonly HarnessModels[],
  harness: string,
  model: string
): readonly ThinkingLevel[] {
  const found = findModel(lists, harness, model);
  if (found) return found.row.thinking.levels;
  const listed = new Set(allModels(lists, harness).flatMap((row) => row.thinking.levels));
  return THINKING_LEVELS.filter((level) => listed.has(level));
}

/**
 * The level a chat runs after its model changes: its own if the model offers
 * it, else the nearest one below. `off` is what a model with no thinking
 * control leaves behind, not a choice, so a model that has one starts from
 * `fallback`, the user's default.
 */
export function fitThinkingLevel(
  current: ThinkingLevel,
  levels: readonly ThinkingLevel[],
  fallback: ThinkingLevel
): ThinkingLevel {
  return clampThinkingLevel(current === "off" ? fallback : current, levels) ?? "off";
}

/**
 * The model a new chat on `harness` starts on: the first of Deus's preferences
 * the list offers, else the harness's own default, else its first row.
 */
export function defaultModelId(
  lists: readonly HarnessModels[],
  harness: string
): string | undefined {
  const rows = pickerModels(lists, harness);
  const preferred = PREFERRED_MODELS[listedHarness(harness) as LocalHarness] ?? [];
  for (const id of preferred) if (rows.some((row) => row.id === id)) return id;
  // Claude marks its account-default alias; the row that runs the same model is the pick.
  const marked = allModels(lists, harness).find((row) => row.isDefault);
  const runs = marked && (marked.resolvedId ?? marked.id);
  return (rows.find((row) => (row.resolvedId ?? row.id) === runs) ?? rows[0])?.id;
}

// ── Picker values ──────────────────────────────────────────────────────────

/** A picker value names its harness and model: `claude-code:opus`. */
export function modelValue(harness: AgentHarness, model: string): string {
  return `${harness}:${model}`;
}

/** Harness spellings older builds stored, and the harness each became. */
const RETIRED_HARNESS_PREFIXES: Readonly<Record<string, AgentHarness>> = {
  claude: "claude-code",
  "codex-server": "codex-app-server",
};

/**
 * Read a picker value, as stored or typed. A retired harness spelling is read
 * as the harness it became. A value from the Codex harnesses the engine no
 * longer runs (`codex:`, `codex-sdk:`) named models it no longer lists, so it
 * reads as Codex's default. `undefined` when it names no harness Deus knows.
 */
export function parseModelValue(
  value: string
): { harness: AgentHarness; model: string } | undefined {
  const text = value.trim();
  const colon = text.indexOf(":");
  if (colon <= 0 || colon === text.length - 1) return undefined;
  const prefix = text.slice(0, colon).toLowerCase();
  const model = text.slice(colon + 1);
  if (prefix === "codex" || prefix === "codex-sdk") {
    const fallback = defaultModelId(CATALOG_MODEL_LISTS, "codex-app-server");
    return fallback ? { harness: "codex-app-server", model: fallback } : undefined;
  }
  const harness = AgentHarnessSchema.safeParse(RETIRED_HARNESS_PREFIXES[prefix] ?? prefix);
  return harness.success ? { harness: harness.data, model } : undefined;
}

/** The picker value a new chat on `harness` starts on, from the engine's own catalog. */
export function defaultModelValue(harness: AgentHarness): string {
  const listed = listedHarness(harness) as AgentHarness;
  const model = defaultModelId(CATALOG_MODEL_LISTS, listed);
  if (!model) throw new Error(`The engine's catalog lists no ${harness} model`);
  return modelValue(listed, model);
}

/** The model a new chat starts on. */
export const DEFAULT_MODEL = defaultModelValue(DEFAULT_AGENT_HARNESS);
