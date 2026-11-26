import { gatewayProvider } from "./gateway-provider";
import {
  gatewayLabel,
  gatewayEffort,
  gatewaySupports,
  gatewayThinking,
  type GatewayCatalog,
  type GatewayPreset,
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
  thinkingLevelLabel,
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
  provider?: string;
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

export function providerGroups<T extends { provider?: string }>(models: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const label = gatewayProvider(model.provider ?? "").label;
    const group = groups.get(label);
    if (group) group.push(model);
    else groups.set(label, [model]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

export function modelKeywords({ id, label, provider }: PickerOption) {
  return provider === undefined
    ? [label, id]
    : [label, id, provider, gatewayProvider(provider).label];
}

export function filterModel(_value: string, search: string, keywords: string[] = []) {
  const query = search.trim().toLowerCase();
  return keywords.some((word) => word.toLowerCase().includes(query)) ? 1 : 0;
}

export function modelPickerView(
  lists: readonly PickerModelList[],
  model: string | undefined,
  gateways?: readonly GatewayCatalog[] | null,
  previousLabel?: string
) {
  const current = model ? parseModelValue(model) : undefined;
  const selectedValue =
    current && modelValue(current.harness, current.model, current.gatewayRevision);
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
    return [
      {
        source: "subscriptions",
        agentHarness: harness,
        label: HARNESSES[harness].label,
        options,
        empty,
      },
    ];
  });
  for (const gateway of gateways ?? []) {
    for (const agentHarness of LOCAL_HARNESSES) {
      const options = gateway.models
        .filter((row) => gatewaySupports(gateway, row, agentHarness))
        .map(
          (row): PickerOption => ({
            id: row.id,
            label: row.label,
            provider: row.provider,
            agentHarness,
            value: modelValue(agentHarness, row.id, gateway.revision),
            thinking: gatewayThinking(row, agentHarness),
            gatewayRevision: gateway.revision,
          })
        );
      if (!options.length) continue;
      selected ??= options.find((option) => option.value === selectedValue);
      groups.push({
        source: gateway.ref,
        agentHarness,
        label: HARNESSES[agentHarness].label,
        options,
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

export interface PickerChat extends ChatEffort {
  model: string | undefined;
  agentHarness?: AgentHarness;
  lists: readonly PickerModelList[];
  gateways?: readonly GatewayCatalog[];
  previousGateway?: { ref?: string; label: string };
  previousLabel?: string;
  hasMessages: boolean;
}

export interface PickerTab {
  value: string;
  label: string;
  preset?: GatewayPreset;
}

export function pickerPage(
  chat: PickerChat,
  { groups, selected }: ReturnType<typeof modelPickerView>,
  browse?: { source: string; agent?: string }
) {
  const { model, gateways = [], previousGateway, agentHarness } = chat;
  const revision = selected?.gatewayRevision;
  const currentGateway = gateways.find((g) => g.revision === revision);
  const requested = browse?.source ?? (revision && (currentGateway?.ref ?? previousGateway?.ref));
  const gateway = gateways.find((g) => g.ref === requested);
  const source = gateway?.ref ?? "subscriptions";
  const tabs = groups.filter((group) => group.source === source);
  const shown =
    tabs.find((group) => group.agentHarness === (browse?.agent ?? agentHarness)) ?? tabs[0];
  const newChat =
    !!agentHarness &&
    !!shown &&
    changesRoute(
      { agentHarness, gatewayRevision: revision },
      { agentHarness: shown.agentHarness, gatewayRevision: gateway?.revision },
      chat.hasMessages
    );
  const gatewayName = currentGateway
    ? gatewayLabel(currentGateway, gateways)
    : (previousGateway?.label ?? "Gateway");
  const hint =
    revision && selected
      ? gatewayName + " · " + HARNESSES[selected.agentHarness].label
      : "Model and thinking effort";
  const empty =
    shown?.empty ??
    (gateway && !shown ? { message: "No chat models available.", openSettings: true } : undefined);
  const label = selected?.label ?? model ?? (agentHarness && HARNESSES[agentHarness].label);
  const effort = selected?.thinking?.levels.length
    ? thinkingLevelLabel(chat.thinkingLevel)
    : undefined;
  const chipName = model
    ? `Select model, currently ${label}${effort ? ", thinking " + effort : ""}`
    : `Select a model for ${label}`;
  const sources: PickerTab[] = [
    { value: "subscriptions", label: "Your subscriptions" },
    ...gateways.map((g) => ({ value: g.ref, label: gatewayLabel(g, gateways), preset: g.preset })),
  ];
  const agents = tabs.map(({ agentHarness: value, label }) => ({ value, label }));
  const options = shown?.options ?? [];
  const initialModel = selected && options.includes(selected) ? selected.value : undefined;
  const preset = revision ? (currentGateway?.preset ?? "custom") : undefined;
  return {
    source,
    sources,
    agents,
    agent: shown?.agentHarness ?? "",
    selected,
    options,
    label,
    chipName,
    effort,
    initialModel,
    preset,
    hint,
    empty,
    newChat,
  };
}

export type PickerPage = ReturnType<typeof pickerPage>;
