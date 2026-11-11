// shared/cloud-models.ts
// What a turn in Deus Cloud may name, in the platform's own vocabulary.
//
// A cloud turn and every automation run execute in an AGNT sandbox, and AGNT
// chooses none of the three things a turn names: its harness, model and
// thinking level. Which ones it runs is AGNT's to say: `listModels()`
// (GET /models) serves one list per harness, generated from the CLIs a new
// sandbox runs. The lists are the engine's own shape and vocabulary, the same
// as a local chat's (shared/models.ts); what differs is who is asked. The
// rules here are the platform's: a turn must name all three, and a listed
// model must be given one of its own levels.
//
// Nothing in a list is a default (the platform drops the catalog's own), so a
// picker built from one starts from the user's choice or deus's visible one.

import {
  THINKING_LEVELS,
  ThinkingLevelSchema,
  TurnSelectionSchema,
  type ModelDescriptor,
  type ThinkingLevel,
  type TurnHarness,
  type TurnModelList,
} from "@deus-hq/api";

export type CloudThinkingLevel = ThinkingLevel;
export type CloudHarness = TurnHarness;
/** One harness's list, as `listModels()` returns it. */
export type CloudModelList = TurnModelList;
export type CloudModel = ModelDescriptor;

/** Every level AGNT's vocabulary has, lowest first. */
export const CLOUD_THINKING_LEVELS: readonly CloudThinkingLevel[] = THINKING_LEVELS;

/** The harness automation runs use: AGNT runs them on Claude Code. */
export const AUTOMATION_HARNESS: CloudHarness = "claude-code";

/** `q:request cloudModels`: the platform's lists, or none without a cloud account to ask. */
export interface CloudModelCatalog {
  configured: boolean;
  lists: CloudModelList[];
}

/** A thinking level in AGNT's vocabulary; undefined when the value names none. */
export function readCloudThinkingLevel(value: unknown): CloudThinkingLevel | undefined {
  const parsed = ThinkingLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The models `harness` lists, in the platform's order; none when it lists no such harness. */
export function cloudModelsFor(
  lists: readonly CloudModelList[],
  harness: string
): readonly CloudModel[] {
  return lists.find((list) => list.harness === harness)?.models ?? [];
}

/** The model `harness` lists under `model`, if it lists it. */
export function findCloudModel(
  lists: readonly CloudModelList[],
  harness: string,
  model: string
): CloudModel | undefined {
  return cloudModelsFor(lists, harness).find((listed) => listed.id === model);
}

/**
 * The levels a turn on this model may name, lowest first: its own, or `off`
 * alone for a model that lists none (Haiku has no thinking control).
 */
export function cloudModelThinkingLevels(model: CloudModel): readonly CloudThinkingLevel[] {
  return model.thinking.levels.length > 0 ? model.thinking.levels : ["off"];
}

/**
 * Why Deus Cloud would not run `model` at `thinkingLevel` as named, or
 * undefined when it would. A model the list does not name is refused only when
 * `requireListed` (it is being chosen now); one carried over from a saved spec
 * stays the platform's to judge. A listed model must be given one of its own
 * levels: AGNT would quietly run the nearest one instead.
 */
export function cloudModelChoiceProblem(
  lists: readonly CloudModelList[],
  choice: {
    harness: string;
    model: string;
    thinkingLevel: CloudThinkingLevel;
    requireListed: boolean;
  }
): string | undefined {
  const models = cloudModelsFor(lists, choice.harness);
  // The platform listed nothing for this harness: there is nothing to check against.
  if (models.length === 0) return undefined;
  const listed = models.find((model) => model.id === choice.model);
  if (!listed) {
    return choice.requireListed
      ? `Deus Cloud doesn't run "${choice.model}". Choose one of: ${models
          .map((model) => model.id)
          .join(", ")}.`
      : undefined;
  }
  const levels = cloudModelThinkingLevels(listed);
  if (levels.includes(choice.thinkingLevel)) return undefined;
  return `${listed.label} runs thinking ${levels.join(", ")} — choose one of those.`;
}

/** What a cloud turn names. AGNT refuses a turn that leaves out any of the three. */
export interface CloudTurnSelection {
  harness: CloudHarness;
  model: string;
  thinkingLevel: CloudThinkingLevel;
}

/**
 * The selection a cloud turn sends, or why it cannot be sent. The platform's
 * own schema decides (so `default`, which lets the CLI choose, is no model
 * either); the messages are deus's. Read before the turn is admitted, so a
 * refusal comes back as a rejected send instead of a turn that fails later.
 */
export function readCloudTurnSelection(input: {
  harness: unknown;
  model: unknown;
  thinkingLevel: unknown;
}): { ok: true; selection: CloudTurnSelection } | { ok: false; message: string } {
  const parsed = TurnSelectionSchema.safeParse(input);
  if (parsed.success) return { ok: true, selection: parsed.data };
  const field = parsed.error.issues[0]?.path[0];
  const message =
    field === "harness"
      ? "This agent isn't available in cloud workspaces — pick a Claude or Codex model."
      : field === "model"
        ? "Choose the model this cloud turn runs."
        : "Choose the thinking level this cloud turn runs.";
  return { ok: false, message };
}
