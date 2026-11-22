import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { CLOUD_HARNESSES, LOCAL_HARNESSES } from "@shared/harnesses";
import { call } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { CATALOG_MODEL_LISTS, type HarnessModels } from "@shared/models";
import { useCloudModels } from "./useCloudModels";

/**
 * The models a chat's pickers offer. A cloud chat gets the platform's lists; a
 * local one gets what this computer's CLIs list for its login, asked for the
 * workspace's folder. Before an answer arrives, and when none can be had, the
 * engine's own catalog: the same shape, so a picker is never empty.
 *
 * Local lists sit under one key prefix, which a login change invalidates
 * (useAgentAuthEvents); the engine reads the CLI again after one.
 */
export function useModelLists(chat: {
  cloud: boolean;
  workspaceId?: string | null;
}): readonly HarnessModels[] {
  return useModelListsState(chat).lists;
}

/**
 * The lists, and whether a harness's is live: this computer's CLI answered
 * for it (the platform's, for a cloud chat). Until then it is the catalog,
 * which a chat's choices must not be fitted to for good.
 */
export function useModelListsState(chat: { cloud: boolean; workspaceId?: string | null }): {
  lists: readonly HarnessModels[];
  live: (harness: string) => boolean;
} {
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
  const cloud = useCloudModels({ enabled: chat.cloud });

  const harnesses = chat.cloud ? CLOUD_HARNESSES : LOCAL_HARNESSES;
  const answer = chat.cloud ? cloud.data?.lists : local.data?.lists;
  const source = answer?.length ? answer : CATALOG_MODEL_LISTS;
  return {
    // A partial answer keeps the missing harness's tab, including a saved selection in it.
    lists: harnesses.map(
      (harness) => source.find((list) => list.harness === harness) ?? { harness, models: [] }
    ),
    live: (harness) => {
      const list = answer?.find((entry) => entry.harness === harness);
      // A platform row is authoritative whatever its source.
      return (
        !!list && harnesses.some((id) => id === harness) && (chat.cloud || list.source === "live")
      );
    },
  };
}
