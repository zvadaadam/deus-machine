// TanStack Query hooks for hosted assistants: the live list, and allowing,
// denying or removing an assistant. (The address to paste into one is on the
// relay status: `useRelayStatus`.)

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import type { Assistant, AssistantDecision } from "@shared/types/assistants";
import { call } from "@/platform/ws";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";

const assistantKeys = {
  list: ["assistants", "list"] as const,
};

/** Every assistant that reached this computer, kept current by the host. */
export function useAssistants(enabled = true) {
  useQuerySubscription(api.assistants, { queryKey: assistantKeys.list, enabled });
  return useQuery({
    queryKey: assistantKeys.list,
    queryFn: () => call(api.assistants),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/**
 * Allow an assistant, or deny it (it stays listed, refused); the list shows it
 * at once, and the host's next push agrees.
 */
export function useSetAssistantAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; access: AssistantDecision }) =>
      call(api.setAssistantAccess, input),
    onSuccess: (_, { clientId, access }) => {
      queryClient.setQueryData<Assistant[]>(assistantKeys.list, (list) =>
        list?.map((assistant) =>
          assistant.clientId === clientId ? { ...assistant, access } : assistant
        )
      );
    },
  });
}

/** Forget an assistant: if it connects again, it asks again. */
export function useRemoveAssistant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) => call(api.removeAssistant, { clientId }),
    onSuccess: (_, clientId) => {
      queryClient.setQueryData<Assistant[]>(assistantKeys.list, (list) =>
        list?.filter((assistant) => assistant.clientId !== clientId)
      );
    },
  });
}
