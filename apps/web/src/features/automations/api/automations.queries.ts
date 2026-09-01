/**
 * Automations data layer.
 *
 * Reads flow in via WebSocket (q:subscribe "automations" / "automation_runs"
 * → snapshots on every invalidate); the HTTP-shaped queryFn (sendRequest) is
 * the initial-load fallback. Writes are q:mutate / q:command. staleTime
 * Infinity — freshness is the subscription's job.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { sendCommand, sendMutate, sendRequest } from "@/platform/ws/query-protocol-client";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import type { Automation, AutomationRun } from "@shared/types";

export const automationKeys = {
  all: ["automations"] as const,
  list: ["automations", "list"] as const,
  runs: (automationId: string) => ["automations", "runs", automationId] as const,
};

export interface AutomationFormInput {
  automationId?: string;
  repository_id?: string;
  name?: string;
  prompt?: string;
  cron?: string;
  timezone?: string | null;
  session_policy?: "fresh_session" | "same_session";
  model?: string | null;
}

export function useAutomations(): { data: Automation[] | undefined; isLoading: boolean } {
  // Automations are Mac-backend state; web-direct has none to read and no
  // transport to ask — an enabled query would reject and retry for the page's
  // lifetime.
  const enabled = !isCloudDirectWebMode();
  useQuerySubscription("automations", { queryKey: automationKeys.list, params: {}, enabled });
  const query = useQuery({
    queryKey: automationKeys.list,
    queryFn: () => sendRequest<Automation[]>("automations", {}),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled,
  });
  return { data: query.data, isLoading: query.isLoading };
}

/**
 * The automation whose held sandbox is this workspace — provenance for
 * automation-born workspaces (sidebar zap, header chip). Reads the same
 * cache the Automations view subscribes to; MainLayout keeps it warm.
 */
export function useAutomationForWorkspace(
  workspaceId: string | null | undefined
): Automation | undefined {
  const query = useQuery({
    queryKey: automationKeys.list,
    queryFn: () => sendRequest<Automation[]>("automations", {}),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: !!workspaceId && !isCloudDirectWebMode(),
    select: (list) => list.find((a) => a.workspace_id === workspaceId),
  });
  return query.data ?? undefined;
}

export function useAutomationRuns(automationId: string | null): {
  data: AutomationRun[] | undefined;
  isLoading: boolean;
} {
  useQuerySubscription("automation_runs", {
    queryKey: automationKeys.runs(automationId ?? "none"),
    params: { automationId },
    enabled: !!automationId,
  });
  const query = useQuery({
    queryKey: automationKeys.runs(automationId ?? "none"),
    queryFn: () => sendRequest<AutomationRun[]>("automation_runs", { automationId }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: !!automationId,
  });
  return { data: query.data, isLoading: query.isLoading };
}

async function mutate<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const result = await sendMutate<T>(action, params);
  if (!result.success) throw new Error(result.error || `${action} failed`);
  return result.data as T;
}

/** Create (no automationId) or update (with automationId). */
export function useSaveAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AutomationFormInput) =>
      mutate<Automation>("saveAutomation", input as unknown as Record<string, unknown>),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automationKeys.all });
    },
  });
}

export function useToggleAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ automationId, status }: { automationId: string; status: "active" | "paused" }) =>
      mutate<Automation>("toggleAutomation", { automationId, status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automationKeys.all });
    },
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (automationId: string) => mutate("deleteAutomation", { automationId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automationKeys.all });
    },
  });
}

export function useRunAutomationNow() {
  return useMutation({
    mutationFn: async (automationId: string) => {
      const ack = await sendCommand("runAutomationNow", { automationId });
      if (!ack.accepted) throw new Error(ack.error || "Run failed to start");
      return ack;
    },
  });
}

/** Re-mirror the platform into the backend cache (push refreshes the UI). */
export function refreshAutomations(automationId?: string): void {
  void sendCommand("refreshAutomations", automationId ? { automationId } : {}).catch(() => {
    // Best-effort — stale cache renders fine; the next refresh converges it.
  });
}

export function useOpenAutomationRun() {
  return useMutation({
    mutationFn: async (runId: string) => {
      const ack = await sendCommand("openAutomationRun", { runId });
      if (!ack.accepted) throw new Error(ack.error || "Could not open the run");
      return ack as unknown as { workspaceId: string; sessionId: string };
    },
  });
}
