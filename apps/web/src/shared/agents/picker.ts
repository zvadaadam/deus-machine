import { gatewayProvider } from "./gateway-provider";
import {
  gatewayEffort,
  gatewaySupports,
  gatewayThinking,
  type GatewayCatalog,
} from "@shared/gateways";
import {
  DEFAULT_THINKING_LEVEL,
  fitThinkingLevel,
  findModel,
  modelLabel,
  modelThinkingLevels,
  modelValue,
  parseModelValue,
  pickerModels,
  type HarnessModels,
  type ModelDescriptor,
} from "@shared/models";
import type { AgentHarness } from "@shared/enums";
import { HARNESSES, LOCAL_HARNESSES, knownHarness } from "@shared/harnesses";
import type { ThinkingLevel } from "@shared/protocol";

export type OpenChatWithModel = (model?: string, thinkingLevel?: ThinkingLevel) => void;

export interface PickerModelList extends HarnessModels {
  unanswered?: "pending" | "unavailable";
}

export function emptyModelList(list?: PickerModelList) {
  if (list?.unanswered === "pending") return { message: "Reading models…", openSettings: false };
  if (!list || list.unanswered === "unavailable")
    return { message: "Could not read the model list.", openSettings: false };
  return { message: list.error || "No models available.", openSettings: true };
}

export interface PickerOption {
  id: string;
  value: string;
  label: string;
  description?: string;
  agentHarness: AgentHarness;
  gatewayRevision?: string;
  thinking?: ModelDescriptor["thinking"];
  heading?: { label: string; provider: string };
  unavailable?: boolean;
}

type Route = Pick<PickerOption, "agentHarness" | "gatewayRevision">;

export function changesRoute(current: Route, next: Route, hasMessages: boolean) {
  return (
    hasMessages &&
    (current.agentHarness !== next.agentHarness || current.gatewayRevision !== next.gatewayRevision)
  );
}

interface ChatEffort {
  model?: string;
  thinkingLevel: ThinkingLevel;
  preferredThinking?: ThinkingLevel | null;
  defaultThinking?: ThinkingLevel;
}

export function levelFor(option: PickerOption, chat: ChatEffort, newChat: boolean) {
  if (option.value === chat.model) return chat.thinkingLevel;
  if (!option.thinking?.levels.length) return undefined;
  const { preferredThinking = chat.thinkingLevel, defaultThinking = DEFAULT_THINKING_LEVEL } = chat;
  const requested = newChat ? undefined : (preferredThinking ?? undefined);
  return option.gatewayRevision
    ? gatewayEffort(option.thinking, requested)
    : fitThinkingLevel(requested ?? defaultThinking, option.thinking.levels, defaultThinking);
}

interface PickerGroup {
  source: string;
  agentHarness: AgentHarness;
  label: string;
  options: PickerOption[];
  empty?: ReturnType<typeof emptyModelList>;
}

export function providerGroups<T extends { provider: string }>(models: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const label = gatewayProvider(model.provider).label;
    const group = groups.get(label);
    if (group) group.push(model);
    else groups.set(label, [model]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

export function modelPickerView(
  lists: readonly PickerModelList[],
  model: string | undefined,
  search = "",
  gateways?: readonly GatewayCatalog[] | null,
  previousLabel?: string
) {
  const current = model ? parseModelValue(model) : undefined;
  const selectedValue =
    current && modelValue(current.harness, current.model, current.gatewayRevision);
  const query = search.trim().toLowerCase();
  let selected: PickerOption | undefined;
  const groups = lists.flatMap((list): PickerGroup[] => {
    const harness = knownHarness(list.harness);
    if (!harness) return [];
    const options = pickerModels(lists, harness).map(
      (row): PickerOption => ({
        id: row.id,
        value: modelValue(harness, row.id),
        label: row.label,
        description: row.description,
        thinking: row.thinking,
        agentHarness: harness,
      })
    );
    const empty = options.length ? undefined : emptyModelList(list);
    if (current && !current.gatewayRevision && current.harness === harness) {
      selected = options.find((o) => o.id === current.model);
      if (!selected) {
        const known = findModel(lists, harness, current.model);
        const levels = modelThinkingLevels(lists, harness, current.model);
        selected = {
          thinking: known?.row.thinking ?? (levels.length ? { levels: [...levels] } : undefined),
          id: current.model,
          value: modelValue(harness, current.model),
          label: modelLabel(lists, harness, current.model),
          agentHarness: harness,
        };
        options.unshift(selected);
      }
    }
    const matches = query
      ? options.filter(
          (o) => o.label.toLowerCase().includes(query) || o.id.toLowerCase().includes(query)
        )
      : options;
    return [
      {
        source: "subscriptions",
        agentHarness: harness,
        label: HARNESSES[harness].label,
        options: matches,
        empty:
          empty ??
          (!matches.length ? { message: "No matching models.", openSettings: false } : undefined),
      },
    ];
  });
  for (const gateway of gateways ?? []) {
    for (const agentHarness of LOCAL_HARNESSES) {
      const providers = providerGroups(
        gateway.models.filter((m) => gatewaySupports(gateway, m, agentHarness))
      );
      if (!providers.length) continue;
      const options: PickerOption[] = [];
      for (const [provider, rows] of providers) {
        let heading = providers.length > 1;
        for (const row of rows) {
          const { id, label, provider: rawProvider } = row;
          const thinking = gatewayThinking(row, agentHarness);
          const option: PickerOption = {
            id,
            value: modelValue(agentHarness, id, gateway.revision),
            label,
            thinking,
            agentHarness,
            gatewayRevision: gateway.revision,
          };
          if (option.value === selectedValue) selected = option;
          if (![label, id, provider, rawProvider].some((s) => s.toLowerCase().includes(query)))
            continue;
          if (heading) option.heading = { label: provider, provider: rawProvider };
          heading = false;
          options.push(option);
        }
      }
      groups.push({
        source: gateway.ref,
        agentHarness,
        label: HARNESSES[agentHarness].label,
        options,
        empty: options.length ? undefined : { message: "No matching models.", openSettings: false },
      });
    }
  }
  if (current && current.gatewayRevision && !selected) {
    selected = {
      id: current.model,
      value: modelValue(current.harness, current.model, current.gatewayRevision),
      label: previousLabel || current.model,
      agentHarness: current.harness,
      unavailable: true,
      gatewayRevision: current.gatewayRevision,
    };
  }
  return { groups, selected };
}
