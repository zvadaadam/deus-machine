/**
 * Automations data layer.
 *
 * Reads flow in via WebSocket (q:subscribe "automations" / "automation_runs"
 * → snapshots on every invalidate); the queryFn is the initial-load fallback.
 * staleTime Infinity — freshness is the subscription's job.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type InputOf } from "@shared/api";
import { call } from "@/platform/ws";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import type { Automation, AutomationRun } from "@shared/types";

export const automationKeys = {
  all: ["automations"] as const,
  list: ["automations", "list"] as const,
  runs: (automationId: string) => ["automations", "runs", automationId] as const,
};

export function useAutomations(): { data: Automation[] | undefined; isLoading: boolean } {
  // Automations are Mac-backend state; web-direct has none to read and no
  // transport to ask — an enabled query would reject and retry for the page's
  // lifetime.
  const enabled = !isCloudDirectWebMode();
  useQuerySubscription(api.automations, { queryKey: automationKeys.list, params: {}, enabled });
  const query = useQuery({
    queryKey: automationKeys.list,
    queryFn: () => call(api.automations),
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
    queryFn: () => call(api.automations),
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
  useQuerySubscription(api.automationRuns, {
    queryKey: automationKeys.runs(automationId ?? "none"),
    params: { automationId: automationId! },
    enabled: !!automationId,
  });
  const query = useQuery({
    queryKey: automationKeys.runs(automationId ?? "none"),
    queryFn: () => call(api.automationRuns, { automationId: automationId! }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: !!automationId,
  });
  return { data: query.data, isLoading: query.isLoading };
}

/** Create (no automationId) or update (with automationId). */
export function useSaveAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<typeof api.saveAutomation>) => call(api.saveAutomation, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automationKeys.all });
    },
  });
}

export function useToggleAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InputOf<typeof api.toggleAutomation>) => call(api.toggleAutomation, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automationKeys.all });
    },
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (automationId: string) => call(api.deleteAutomation, { automationId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automationKeys.all });
    },
  });
}

export function useRunAutomationNow() {
  return useMutation({
    mutationFn: (automationId: string) => call(api.runAutomationNow, { automationId }),
  });
}

/** Re-mirror the platform into the backend cache (push refreshes the UI). */
export function refreshAutomations(automationId?: string): void {
  void call(api.refreshAutomations, { automationId }).catch(() => {
    // Best-effort — stale cache renders fine; the next refresh converges it.
  });
}

export function useOpenAutomationRun() {
  return useMutation({
    mutationFn: (runId: string) => call(api.openAutomationRun, { runId }),
  });
}
