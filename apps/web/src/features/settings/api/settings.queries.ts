/**
 * Settings Query Hooks
 * TanStack Query hooks for settings management
 */

import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { produce } from "immer";
import { toast } from "sonner";
import type { AgentAuthAnswer, AgentAuthEvent, HarnessCliProgress } from "@shared/agent-auth";
import { onEvent } from "@/platform/ws";
import { SettingsService } from "./settings.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { track } from "@/platform/analytics";
import type { Settings } from "../types";
import { DEFAULT_THINKING_LEVEL } from "@shared/models";
import { readThinkingLevel, type ThinkingLevel } from "@shared/protocol";

/**
 * Fetch all settings
 */
export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: () => SettingsService.fetch(),
    staleTime: 30000, // Cache for 30s (settings change less frequently)
  });
}

/**
 * Each local agent's login (Claude Code / Codex), as the engine reads it from
 * the agent's CLI, and the sign-ins under way
 */
export function useAgentAuth(enabled = true) {
  return useQuery({
    queryKey: queryKeys.settings.agentAuth,
    queryFn: () => SettingsService.fetchAgentAuth(),
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
            version: progress.version,
            receivedBytes: progress.receivedBytes,
            ...(progress.totalBytes !== undefined && { totalBytes: progress.totalBytes }),
            ...(progress.error && { error: progress.error }),
          }
        : cli
    ),
  };
}

/**
 * The thinking level a new chat starts on: the user's (Settings → AI), else
 * Deus's. Settings written by older builds hold retired UPPERCASE spellings,
 * which are read as what they became.
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
  useEffect(
    () =>
      onEvent((event, data) => {
        if (event === "agent:cli") {
          const progress = data as HarnessCliProgress;
          queryClient.setQueryData<AgentAuthAnswer>(queryKeys.settings.agentAuth, (answer) =>
            answer ? withProgress(answer, progress) : answer
          );
          if (progress.phase === "ready" || progress.phase === "failed") {
            void queryClient.invalidateQueries({ queryKey: queryKeys.settings.agentAuth });
          }
          return;
        }
        if (event !== "agent:auth") return;
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.agentAuth });
        // Another login lists other models.
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.agentModels });
        const login = (data as AgentAuthEvent | undefined)?.login;
        if (login && (login.outcome === "failed" || login.outcome === "expired")) {
          toast.error(login.error ?? "The sign-in didn’t finish");
        }
      }),
    [queryClient]
  );
}

/**
 * Update settings mutation with optimistic update
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: Partial<Settings>) => SettingsService.update(settings),

    // Optimistic update: Apply settings immediately
    onMutate: async (newSettings: Partial<Settings>) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings.all });

      const previousSettings = queryClient.getQueryData<Settings>(queryKeys.settings.all);

      queryClient.setQueryData<Settings>(queryKeys.settings.all, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          Object.assign(draft, newSettings);
        });
      });

      return { previousSettings };
    },

    onError: (_err, _newSettings, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(queryKeys.settings.all, context.previousSettings);
      }
    },

    onSuccess: (_data, newSettings) => {
      // Track each changed key. Only include value for safe enum-type settings
      // (theme, diff view). Never log API keys or free-text inputs.
      const SAFE_VALUE_KEYS = new Set(["theme", "diff_view_mode"]);
      for (const key of Object.keys(newSettings)) {
        const value = SAFE_VALUE_KEYS.has(key)
          ? String((newSettings as Record<string, unknown>)[key])
          : undefined;
        track("setting_changed", { key, value });
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}
