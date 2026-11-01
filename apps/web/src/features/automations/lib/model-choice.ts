/**
 * The automation editor's model and thinking choices, from Deus Cloud's list.
 *
 * Runs use Claude Code in a cloud sandbox, so the options are what the
 * platform lists for it (useCloudModels), never a list deus keeps. What the
 * automation already names stays visible and kept even when the list does not
 * offer it: the editor shows it as it is instead of swapping in a listed one.
 */

import {
  AUTOMATION_HARNESS,
  CLOUD_THINKING_LEVELS,
  cloudModelThinkingLevels,
  cloudModelsFor,
  type CloudModel,
  type CloudModelCatalog,
} from "@shared/cloud-models";

/**
 * The levels to offer for `model`: a listed model's own (`off` alone for one
 * that lists none). A model the loaded list does not name keeps every level,
 * since nothing here knows which it has; the platform judges the run. Before
 * the list loads there is nothing to offer.
 */
export function thinkingLevelsFor(
  models: readonly CloudModel[],
  model: string,
  listLoaded: boolean
): readonly string[] {
  if (!model) return [];
  const listed = models.find((option) => option.id === model);
  if (listed) return cloudModelThinkingLevels(listed);
  return listLoaded ? CLOUD_THINKING_LEVELS : [];
}

export interface AutomationModelChoice {
  /** Whether Deus Cloud's list has been read for a signed-in account. */
  listLoaded: boolean;
  /** The Claude models runs can use, in the platform's order. */
  models: readonly CloudModel[];
  /** The automation's saved model when the list does not (or cannot yet) offer it. */
  savedModel: string | null;
  /** The loaded list positively does not name `savedModel`. */
  savedModelUnlisted: boolean;
  /** The levels to offer for the chosen model, plus a chosen level it does not list. */
  levelOptions: readonly string[];
}

export function automationModelChoice(input: {
  catalog: CloudModelCatalog | undefined;
  /** What the automation names today ("" for a new one). */
  savedModel: string;
  /** The form's current choices ("" until chosen). */
  model: string;
  thinkingLevel: string;
}): AutomationModelChoice {
  const listLoaded = input.catalog?.configured === true;
  const models = cloudModelsFor(input.catalog?.lists ?? [], AUTOMATION_HARNESS);
  const savedModel =
    input.savedModel && !models.some((option) => option.id === input.savedModel)
      ? input.savedModel
      : null;
  const levels = thinkingLevelsFor(models, input.model, listLoaded);
  const levelOptions =
    input.thinkingLevel && !levels.includes(input.thinkingLevel)
      ? [...levels, input.thinkingLevel]
      : levels;
  return {
    listLoaded,
    models,
    savedModel,
    savedModelUnlisted: savedModel !== null && listLoaded,
    levelOptions,
  };
}
