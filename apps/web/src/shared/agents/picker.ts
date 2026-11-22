// What a model picker shows: one group per harness, each harness's rows as its
// list has them. The chat's own model is always among its harness's rows, also
// when no list names it (a window variant such as `…[1m]`, a model an older
// chat ran, one the other lane lists), so a picker never hides what is selected.

import {
  modelLabel,
  modelValue,
  parseModelValue,
  pickerModels,
  type HarnessModels,
} from "@shared/models";
import { AgentHarnessSchema, type AgentHarness } from "@shared/enums";
import { HARNESSES } from "@shared/harnesses";

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
  emptyReason?: string;
}

export interface ModelPickerView {
  groups: PickerGroup[];
  /** The selected value as its group lists it; undefined when it names no harness. */
  selected?: PickerOption;
}

export function modelPickerView(lists: readonly HarnessModels[], model: string): ModelPickerView {
  const current = parseModelValue(model);
  let selected: PickerOption | undefined;
  const groups = lists.flatMap(({ harness, error }): PickerGroup[] => {
    const parsed = AgentHarnessSchema.safeParse(harness);
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
    const emptyReason = options.length ? undefined : error || "No models available.";
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
    return [{ agentHarness, label: HARNESSES[agentHarness].label, options, emptyReason }];
  });
  return { groups, selected };
}
