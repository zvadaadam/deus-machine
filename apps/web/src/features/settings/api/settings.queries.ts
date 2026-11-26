/**
 * Settings Query Hooks
 * TanStack Query hooks for settings management
 */

import {
  useQuery,
  useMutation,
  useMutationState,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentAuthAnswer, HarnessCliProgress } from "@shared/agent-auth";
import { api } from "@shared/api";
import type { InputOf } from "@shared/api/op";
import type { Settings } from "@shared/types/settings";
import { call } from "@/platform/ws";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { useStream } from "@/shared/hooks/useStream";
import { queryKeys } from "@/shared/api/queryKeys";
import { track } from "@/platform/analytics";
import { reconcileAgentInstalls, reportInstallProgress } from "../lib/local-agent-installs";
import { DEFAULT_THINKING_LEVEL } from "@shared/models";
import { readThinkingLevel, type ThinkingLevel } from "@shared/protocol";

export function useSettings() {
  useQuerySubscription(api.settings, {
    queryKey: queryKeys.settings.all,
    enabled: !isCloudDirectWebMode(),
  });
  return useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: () => call(api.settings),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/**
 * Each local agent's login, as the engine reads it from
 * the agent's CLI, and the sign-ins under way
 */
export function useAgentAuth(enabled = true) {
  return useQuery({
    queryKey: queryKeys.settings.agentAuth,
    queryFn: () => call(api.agentAuth),
    staleTime: 60000, // Cache for 60s — agent-server says when a login changes
    enabled,
  });
}

/** An install's progress, as the CLI it makes ready (a missed one is read again at its end). */
function withProgress(answer: AgentAuthAnswer, progress: HarnessCliProgress): AgentAuthAnswer {
  const state =
    progress.phase === "ready" ? "ready" : progress.phase === "failed" ? "failed" : "installing";
  return {
    ...answer,
    clis: answer.clis.map((cli) =>
      cli.harness === progress.harness
        ? {
            harness: cli.harness,
            state,
            version: progress.version || cli.version,
            receivedBytes: progress.receivedBytes,
            ...(progress.totalBytes !== undefined && { totalBytes: progress.totalBytes }),
            ...(progress.error && { error: progress.error }),
          }
        : cli
    ),
  };
}

/**
 * The thinking level a new chat starts on: the user's (Settings → AI Providers), else
 * Deus's.
 */
export function useDefaultThinkingLevel(): ThinkingLevel {
  const { data: settings } = useSettings();
  return readThinkingLevel(settings?.default_thinking_level) ?? DEFAULT_THINKING_LEVEL;
}

/**
 * Follows the local agents: a CLI installing (its progress, then the agent's
 * login once it is ready), a login changing, a sign-in ending (and how one
 * failed).
 */
export function useAgentAuthEvents(): void {
  const queryClient = useQueryClient();
  const filter = isCloudDirectWebMode() ? null : {};
  const readAgain = async (queryKey: QueryKey) => {
    const filters = { queryKey };
    // Invalidation alone can reuse a first read started before the login or CLI changed.
    await queryClient.cancelQueries(filters);
    await queryClient.invalidateQueries(filters);
  };
  const readLoginAndModels = () => {
    void readAgain(queryKeys.settings.agentAuth);
    void readAgain(queryKeys.settings.agentModels);
  };
  useStream(
    api.agentCliProgress,
    filter,
    (progress) => {
      queryClient.setQueryData<AgentAuthAnswer>(queryKeys.settings.agentAuth, (answer) =>
        answer ? withProgress(answer, progress) : answer
      );
      reportInstallProgress(queryClient, progress.harness, progress.phase, progress.error);
      if (progress.phase === "ready") readLoginAndModels();
      if (progress.phase === "failed") void readAgain(queryKeys.settings.agentAuth);
    },
    () => {
      readLoginAndModels();
      return reconcileAgentInstalls(queryClient);
    }
  );
  useStream(
    api.agentAuthChanges,
    filter,
    ({ login }) => {
      readLoginAndModels();
      if (login && (login.outcome === "failed" || login.outcome === "expired")) {
        toast.error(login.error ?? "The sign-in didn’t finish");
      }
    },
    readLoginAndModels
  );
}

type SettingWrite = InputOf<typeof api.saveSetting> & { key: keyof Settings };

export function useUpdateSettings() {
  return useMutation({
    mutationKey: [api.saveSetting.name],
    mutationFn: async (setting: SettingWrite) => {
      await call(api.saveSetting, setting);
      const { key, value } = setting;
      track("setting_changed", {
        key,
        value: key === "chat_view" || key === "diff_view_mode" ? String(value) : undefined,
      });
    },
  });
}

/** Saves arrive here in submission order. A settled choice also clears an older pending one. */
export function useEditableSettings() {
  const { data, isLoading } = useSettings();
  const saves = useMutationState({ filters: { mutationKey: [api.saveSetting.name] } });
  const pending: Settings = {};
  for (const { variables, status } of saves) {
    if (!variables) continue;
    const { key, value } = variables as SettingWrite;
    if (status === "pending") Object.assign(pending, { [key]: value });
    else delete pending[key];
  }
  return { settings: { ...data, ...pending }, isLoading };
}
