// What a model picker shows: one group per harness, each harness's rows as its
// list has them. The chat's own model is always among its harness's rows, also
// when no list names it (a window variant such as `…[1m]`, a model an older
// chat ran, one the other lane lists), so a picker never hides what is selected.

import {
  findModel,
  modelLabel,
  modelValue,
  parseModelValue,
  pickerModels,
  type HarnessModels,
} from "@shared/models";
import { AgentHarnessSchema, type AgentHarness } from "@shared/enums";
import { HARNESSES } from "@shared/harnesses";
import type { ThinkingLevel } from "@shared/protocol";

export interface PickerModelList extends HarnessModels {
  /** The query's state when the engine has supplied no list for this agent. */
  unanswered?: "pending" | "unavailable";
}

export function emptyModelList(list?: PickerModelList) {
  if (list?.unanswered === "pending") return { message: "Reading models…", openSettings: false };
  if (!list || list.unanswered === "unavailable")
    return { message: "Could not read the model list.", openSettings: false };
  return { message: list.error || "No models available.", openSettings: true };
}

export interface PickerOption {
  /** The picker value: `harness:model`. */
  value: string;
  label: string;
  /** What the harness says about the model, when it says anything. */
  description?: string;
  agentHarness: AgentHarness;
}

export interface PickerGroup {
  agentHarness: AgentHarness;
  label: string;
  options: PickerOption[];
  empty?: ReturnType<typeof emptyModelList>;
}

export interface ModelPickerView {
  groups: PickerGroup[];
  /** The selected value as its group lists it; undefined when it names no harness. */
  selected?: PickerOption;
  /** The selected model's declared levels, absent until its row is known. */
  listedLevels?: readonly ThinkingLevel[];
}

export function modelPickerView(
  lists: readonly PickerModelList[],
  model: string | undefined
): ModelPickerView {
  const current = model ? parseModelValue(model) : undefined;
  let selected: PickerOption | undefined;
  const groups = lists.flatMap((list): PickerGroup[] => {
    const parsed = AgentHarnessSchema.safeParse(list.harness);
    if (!parsed.success) return [];
    const agentHarness = parsed.data;
    const options = pickerModels(lists, agentHarness).map(
      (row): PickerOption => ({
        value: modelValue(agentHarness, row.id),
        label: row.label,
        ...(row.description && { description: row.description }),
        agentHarness,
      })
    );
    const empty = options.length ? undefined : emptyModelList(list);
    if (current?.harness === agentHarness) {
      selected = options.find((option) => option.value === modelValue(agentHarness, current.model));
      if (!selected) {
        selected = {
          value: modelValue(agentHarness, current.model),
          label: modelLabel(lists, agentHarness, current.model),
          agentHarness,
        };
        options.unshift(selected);
      }
    }
    return [{ agentHarness, label: HARNESSES[agentHarness].label, options, empty }];
  });
  const listedLevels =
    current && findModel(lists, current.harness, current.model)?.row.thinking.levels;
  return { groups, selected, listedLevels };
}
