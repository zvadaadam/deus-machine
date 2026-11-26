import { gatewaySupports, gatewayThinking } from "@shared/gateways";
import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { CLOUD_HARNESSES, LOCAL_HARNESSES, knownHarness } from "@shared/harnesses";
import type { GatewayCatalog, GatewayModel } from "@shared/gateways";
import type { AgentHarness } from "@shared/enums";
import type { SessionTurn } from "@shared/types/session";
import type { ThinkingLevel } from "@shared/protocol";
import { call } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { emptyModelList, type PickerModelList } from "@/shared/agents/picker";
import {
  type ModelDescriptor,
  CATALOG_MODEL_LISTS,
  DEFAULT_AGENT_HARNESS,
  modelForSession,
  latestTurnExecution,
  modelThinkingLevels,
  modelValue,
  parseModelValue,
} from "@shared/models";
import { useGateways } from "./useGateways";
import { useCloudModels } from "./useCloudModels";

type ModelScope = { cloud: boolean; workspaceId?: string | null };

interface ModelListsState {
  gateways?: readonly GatewayCatalog[];
  lists: readonly PickerModelList[];
  live: (harness: string) => boolean;
}

export interface ChatModelSelection extends ModelListsState {
  agentHarness?: AgentHarness;
  model?: string;
  picked?: string;
  gatewayModel?: GatewayModel;
  gatewayThinking?: ModelDescriptor["thinking"];
  previousLabel?: string;
  previousGateway?: { ref?: string; label: string };
  thinkingLevels: readonly ThinkingLevel[];
  unavailable?: string;
}

/** A pick belongs to its lane. Without one the chat follows its history and its harness's list. */
export function useChatModel({
  picked,
  harness: storedHarness = DEFAULT_AGENT_HARNESS,
  turns = [],
  gatewayRevision,
  ...scope
}: ModelScope & {
  picked?: string;
  harness?: string;
  turns?: readonly SessionTurn[];
  gatewayRevision?: string | null;
}): ChatModelSelection {
  const state = useModelListsState(scope);
  const harness = knownHarness(storedHarness);
  if (!harness)
    return {
      ...state,
      thinkingLevels: [],
      unavailable: `This chat's agent, "${storedHarness}", is not one this version of Deus runs.`,
    };
  const selection = picked ? parseModelValue(picked) : undefined;
  const sameRoute =
    gatewayRevision === undefined ||
    (selection?.harness === harness && (selection.gatewayRevision ?? null) === gatewayRevision);
  const eligible =
    selection &&
    (!selection.gatewayRevision || !scope.cloud) &&
    sameRoute &&
    state.lists.some((list) => list.harness === selection.harness);
  const agentHarness = eligible ? selection.harness : harness;
  const revision = eligible ? selection.gatewayRevision : gatewayRevision;
  const id = eligible
    ? selection.model
    : modelForSession(harness, turns, gatewayRevision ? [] : state.lists);
  const model = id && modelValue(agentHarness, id, revision);
  const gateway = revision ? state.gateways?.find((g) => g.revision === revision) : undefined;
  const gatewayModel = gateway?.models.find(
    (m) => m.id === id && gatewaySupports(gateway, m, agentHarness)
  );
  const thinking = gatewayThinking(gatewayModel, agentHarness);
  const latest = latestTurnExecution(harness, turns);
  let unavailable;
  if (revision && !gatewayModel)
    unavailable = state.gateways
      ? "This gateway model is no longer available."
      : "Reading gateways…";
  else if (!id)
    unavailable = emptyModelList(state.lists.find((list) => list.harness === agentHarness)).message;
  return {
    ...state,
    agentHarness,
    gatewayModel,
    gatewayThinking: thinking,
    previousGateway:
      revision && latest?.via ? { label: latest.via, ref: latest.gatewayRef } : undefined,
    previousLabel: revision && latest?.model === id ? latest?.modelLabel : undefined,
    model,
    picked: eligible ? model : undefined,
    thinkingLevels:
      id && !revision
        ? modelThinkingLevels(state.lists, agentHarness, id)
        : (thinking?.levels ?? []),
    unavailable,
  };
}

/**
 * The models a chat's pickers offer. A cloud chat gets the platform's lists; a
 * local one gets what this computer's CLIs list for its login, asked for the
 * workspace's folder. Before an answer arrives, and when none can be had, the
 * engine's own catalog, which may have no rows for a harness.
 *
 * Local lists sit under one key prefix, which a login change invalidates
 * (useAgentAuthEvents); the engine reads the CLI again after one.
 */
function useModelListsState(chat: ModelScope): ModelListsState {
  const workspaceId = chat.workspaceId ?? null;
  const local = useQuery({
    queryKey: [...queryKeys.settings.agentModels, workspaceId],
    queryFn: () => call(api.agentModels, workspaceId ? { workspaceId } : {}),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    // Web-direct has no computer to ask.
    enabled: !chat.cloud && !isCloudDirectWebMode(),
  });
  const gateways = useGateways(!chat.cloud && !isCloudDirectWebMode()).data;
  const cloud = useCloudModels({ enabled: chat.cloud });

  const harnesses = chat.cloud ? CLOUD_HARNESSES : LOCAL_HARNESSES;
  const query = chat.cloud ? cloud : local;
  const answer = query.data?.lists;
  const catalog = answer?.length ? [] : CATALOG_MODEL_LISTS;
  return {
    gateways: chat.cloud ? undefined : gateways,
    // A partial answer keeps the missing harness's tab, including a saved selection in it.
    lists: harnesses.map((harness) => {
      const list = answer?.find((entry) => entry.harness === harness);
      if (list) return list;
      return {
        harness,
        source: "catalog",
        models: catalog.find((entry) => entry.harness === harness)?.models ?? [],
        ...(!answer && {
          unanswered: query.isPending && query.isEnabled ? "pending" : "unavailable",
        }),
      };
    }),
    live: (harness) => {
      const list = answer?.find((entry) => entry.harness === harness);
      // A platform row is authoritative whatever its source.
      return (
        !!list && harnesses.some((id) => id === harness) && (chat.cloud || list.source === "live")
      );
    },
  };
}
