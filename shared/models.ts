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
// Each harness's preferences live in harnesses.ts. This file chooses a model
// and thinking level from what a list offers.

import {
  CATALOG_MODELS,
  THINKING_LEVELS,
  clampThinkingLevel,
  type ModelDescriptor,
  type ModelList,
  type ThinkingLevel,
} from "@zvada/agent-server/protocol";
import { AgentHarnessSchema, type AgentHarness } from "./enums";
import { HARNESSES, LOCAL_HARNESSES, harnessInfo } from "./harnesses";
import type { SessionTurn } from "./types/session";

export type { ModelDescriptor, ModelList };

/** One harness's models: the part of a list a picker reads. */
export interface HarnessModels extends Pick<ModelList, "source" | "error"> {
  readonly harness: string;
  readonly models: readonly ModelDescriptor[];
}

export function noModelsReason(list: HarnessModels | undefined): string {
  return list?.error || "No models available.";
}

/** `q:request agentModels`: each local harness's list, as the engine has it. */
export interface AgentModelsAnswer {
  lists: ModelList[];
}

// ── What Deus chooses ──────────────────────────────────────────────────────

/**
 * The harness `name` means: its id, its name, or its name's first word
 * ("claude-code", "Claude Code", "Claude"; "codex-app-server", "Codex"), in
 * any case and with spaces, hyphens and underscores aside.
 */
export function harnessNamed(name: string): AgentHarness | undefined {
  const key = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");
  const wanted = key(name);
  return LOCAL_HARNESSES.find((id) => {
    const { label } = HARNESSES[id];
    return [id, label, label.split(" ")[0]!].some((said) => key(said) === wanted);
  });
}

export const DEFAULT_AGENT_HARNESS = "claude-code" satisfies AgentHarness;
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

// ── Lists ──────────────────────────────────────────────────────────────────

/** Claude's alias for whatever the account's default is: not a row a chat picks. */
const ACCOUNT_DEFAULT_MODEL = "default";

/** The lists the embedded engine was built with. */
export const CATALOG_MODEL_LISTS: readonly HarnessModels[] = LOCAL_HARNESSES.map((harness) => ({
  harness,
  source: "catalog",
  models: CATALOG_MODELS.filter((model) => model.harness === harness),
}));

function allModels(lists: readonly HarnessModels[], harness: string): readonly ModelDescriptor[] {
  return lists.find((list) => list.harness === harness)?.models ?? [];
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
 * `fallback`, the user's default; so does a level the model has no match for
 * (one only another model lists), fitted in turn to the model's own levels.
 * `off` only for a model with no thinking control.
 */
export function fitThinkingLevel(
  current: ThinkingLevel,
  levels: readonly ThinkingLevel[],
  fallback: ThinkingLevel
): ThinkingLevel {
  const own = current === "off" ? undefined : clampThinkingLevel(current, levels);
  return own ?? clampThinkingLevel(fallback, levels) ?? levels[0] ?? "off";
}

/**
 * The level a chat shows and sends. `levels`: the model's, when its list is
 * live; none while it is provisional (the catalog the engine was built with,
 * before this computer's CLIs answered), when the chat keeps the level it
 * asked for: the live list may well offer it. Once the list is live, the
 * level fitted to the model's, which the chat then keeps.
 */
export function composerThinking(
  requested: ThinkingLevel,
  levels: readonly ThinkingLevel[] | undefined,
  fallback: ThinkingLevel
): ThinkingLevel {
  return levels ? fitThinkingLevel(requested, levels, fallback) : requested;
}

/** How a level is shown: Deus's word for one it knows, else the level's own name, capitalised. */
export function thinkingLevelLabel(level: ThinkingLevel): string {
  return LEVEL_LABELS.get(level) ?? level.charAt(0).toUpperCase() + level.slice(1);
}

// A Map, not an object: the level is an open vocabulary, and `constructor` or
// `__proto__` must read as levels like any other, not as the object's own.
const LEVEL_LABELS = new Map<string, string>([
  ["off", "Off"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
  ["ultra", "Ultra"],
]);

/**
 * The model a new chat on `harness` starts on: the first of Deus's preferences
 * the list offers, else the harness's own default, else its first row.
 */
export function defaultModelId(
  lists: readonly HarnessModels[],
  harness: string
): string | undefined {
  const rows = pickerModels(lists, harness);
  const preferred = harnessInfo(harness)?.preferredModels ?? [];
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

/**
 * Read a picker value, as stored or typed. A value from the Codex harness the
 * engine no longer runs (`codex:`) named models it no longer lists, so it reads
 * as Codex's default. `undefined` when it names no harness Deus knows.
 */
export function parseModelValue(
  value: string
): { harness: AgentHarness; model: string } | undefined {
  const text = value.trim();
  const colon = text.indexOf(":");
  if (colon <= 0 || colon === text.length - 1) return undefined;
  const prefix = text.slice(0, colon).toLowerCase();
  const model = text.slice(colon + 1);
  if (prefix === "codex") {
    const fallback = defaultModelId(CATALOG_MODEL_LISTS, "codex-app-server");
    return fallback ? { harness: "codex-app-server", model: fallback } : undefined;
  }
  const harness = AgentHarnessSchema.safeParse(prefix);
  return harness.success ? { harness: harness.data, model } : undefined;
}

/** An unbound chat starts on Claude, which ships model rows in the engine's catalog. */
export const DEFAULT_MODEL = modelValue(
  DEFAULT_AGENT_HARNESS,
  defaultModelId(CATALOG_MODEL_LISTS, DEFAULT_AGENT_HARNESS)!
);

/**
 * The model and thinking level a chat continues on: those its latest turn on
 * `harness` ran (latest by start, else by end), as that turn recorded them.
 * Undefined when no turn on that harness recorded a model: the chat starts on
 * the defaults.
 */
export function latestTurnExecution(
  harness: string,
  turns: readonly Pick<SessionTurn, "execution" | "startedAt" | "endedAt">[]
): SessionTurn["execution"] {
  let latest: (typeof turns)[number] | undefined;
  const at = (turn: (typeof turns)[number]) => turn.startedAt ?? turn.endedAt ?? 0;
  for (const turn of turns) {
    if (turn.execution?.harness !== harness || !turn.execution.model) continue;
    if (!latest || at(turn) > at(latest)) latest = turn;
  }
  return latest?.execution;
}

/** Without an explicit pick, continue on the recorded model or take this harness's own default. */
export function modelForSession(
  harness: string,
  turns: readonly SessionTurn[],
  lists: readonly HarnessModels[]
): string | undefined {
  return latestTurnExecution(harness, turns)?.model ?? defaultModelId(lists, harness);
}

/**
 * The thinking level a chat continues on after that turn: the one it asked
 * for (what the composer showed), else, for a turn sent without one, the
 * level the harness ran it at.
 */
export function continuedThinkingLevel(
  execution: SessionTurn["execution"]
): ThinkingLevel | undefined {
  return execution?.thinkingLevel ?? execution?.appliedThinkingLevel;
}
