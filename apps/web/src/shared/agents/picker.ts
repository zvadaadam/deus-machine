// What a model picker shows: one group per harness, each harness's rows as its
// list has them. The chat's own model is always among its harness's rows, also
// when no list names it (a window variant such as `…[1m]`, a model an older
// chat ran, one the other lane lists), so a picker never hides what is selected.

import {
  HARNESS_LABELS,
  PICKER_HARNESSES,
  modelLabel,
  modelValue,
  parseModelValue,
  pickerModels,
  type HarnessModels,
} from "@shared/models";
import type { AgentHarness } from "@shared/enums";

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
}

export interface ModelPickerView {
  groups: PickerGroup[];
  /** The selected value as its group lists it; undefined when it names no harness. */
  selected?: PickerOption;
}

export function modelPickerView(lists: readonly HarnessModels[], model: string): ModelPickerView {
  const current = parseModelValue(model);
  let selected: PickerOption | undefined;
  const groups = PICKER_HARNESSES.map((agentHarness): PickerGroup => {
    const options = pickerModels(lists, agentHarness).map(
      (row): PickerOption => ({
        value: modelValue(agentHarness, row.id),
        label: row.label,
        ...(row.description && { description: row.description }),
        agentHarness,
      })
    );
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
    return { agentHarness, label: HARNESS_LABELS[agentHarness], options };
  });
  return { groups, selected };
}
