/**
 * Customize data layer.
 *
 * Two reads make the page: the catalog, static for a build and fetched once,
 * and the state (what is installed and connected), a few kilobytes pushed on
 * every backend change. `composeSnapshot` joins them into the views the UI
 * draws. Lists only a page needs (an app's tools, a skill's SKILL.md, the
 * skills already on this computer) are read when that page opens.
 *
 * The effects of a write arrive through the subscription, so no mutation
 * patches the cache by hand.
 */

import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type InputOf } from "@shared/api";
import { getErrorMessage } from "@shared/lib/errors";
import { call } from "@/platform/ws";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { composeSnapshot } from "@shared/integrations/compose";
import type { CustomAppInput, IntegrationsSnapshot } from "@shared/integrations/types";

export const integrationKeys = {
  catalog: ["integrations", "catalog"] as const,
  state: ["integrations", "state"] as const,
  appTools: (appId: string, checkedAt: string | null) =>
    ["integrations", "app-tools", appId, checkedAt ?? "never"] as const,
  skillContent: (skillId: string, ref: string | null) =>
    ["integrations", "skill-content", skillId, ref ?? "remote"] as const,
  localSkills: ["integrations", "local-skills"] as const,
};

const ON_DEMAND = { staleTime: Infinity, refetchOnWindowFocus: false } as const;

export function useIntegrations(): {
  data: IntegrationsSnapshot | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  // Installs live on the Mac backend; web-direct has none to read.
  const enabled = !isCloudDirectWebMode();
  useQuerySubscription(api.integrations, { queryKey: integrationKeys.state, params: {}, enabled });
  const state = useQuery({
    queryKey: integrationKeys.state,
    queryFn: () => call(api.integrations),
    ...ON_DEMAND,
    enabled,
  });
  // Keyed by the version the state names: a newer backend's catalog is read afresh.
  const version = state.data?.catalogVersion;
  const catalog = useQuery({
    queryKey: [...integrationKeys.catalog, version ?? "unknown"],
    queryFn: () => call(api.integrationsCatalog),
    ...ON_DEMAND,
    enabled: enabled && version !== undefined,
  });
  const data = useMemo(
    () => (catalog.data && state.data ? composeSnapshot(catalog.data, state.data) : undefined),
    [catalog.data, state.data]
  );
  return {
    data,
    isLoading: state.isLoading || catalog.isLoading,
    error: state.error ?? catalog.error,
  };
}

/** The tools an app's server listed at its last check; read again after each check. */
export function useAppTools(appId: string, checkedAt: string | null, enabled: boolean) {
  return useQuery({
    queryKey: integrationKeys.appTools(appId, checkedAt),
    queryFn: () => call(api.appTools, { appId }),
    ...ON_DEMAND,
    enabled,
  });
}

/** Skills already on this computer that Deus did not add (read when the Skills view opens). */
export function useLocalSkills(enabled: boolean) {
  return useQuery({
    queryKey: integrationKeys.localSkills,
    queryFn: () => call(api.localSkills),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled,
  });
}

/**
 * How long the two writes that wait on the outside world may take: a check
 * starts a local server (its first run downloads it; the backend allows 90
 * seconds), and adding a skill downloads its repository (120 seconds). The
 * default would give up on them while they are still under way.
 */
const SLOW_WRITE = { timeoutMs: 150_000 };

/**
 * Every write says its own failure, here at the hook: a callback handed to
 * `mutate()` is dropped when its row remounts mid-request (installing moves
 * a row to another section).
 */
const reportFailure = { onError: (error: unknown) => void toast.error(getErrorMessage(error)) };

export function useInstall() {
  return useMutation({
    ...reportFailure,
    mutationFn: (item: InputOf<typeof api.installIntegration>) =>
      call(api.installIntegration, item),
  });
}

export function useUninstall() {
  return useMutation({
    ...reportFailure,
    mutationFn: (item: InputOf<typeof api.uninstallIntegration>) =>
      call(api.uninstallIntegration, item),
  });
}

export function useSetEnabled() {
  return useMutation({
    ...reportFailure,
    mutationFn: (input: InputOf<typeof api.setIntegrationEnabled>) =>
      call(api.setIntegrationEnabled, input),
  });
}

export function useDisconnectApp() {
  return useMutation({
    ...reportFailure,
    mutationFn: (appId: string) => call(api.disconnectApp, { appId }),
  });
}

export function useCheckApp() {
  return useMutation({
    ...reportFailure,
    mutationFn: (appId: string) => call(api.checkApp, { appId }, SLOW_WRITE),
  });
}

/**
 * Add the user's own server. A local server's keys are connected right after
 * (sealed in the vault), so they never sit in its command. Keys that are
 * refused are reported and the server stays added: its page asks for them
 * again, and trying again from the form would add it a second time.
 */
export function useAddCustomApp() {
  return useMutation({
    ...reportFailure,
    mutationFn: async ({
      input,
      values,
    }: {
      input: CustomAppInput;
      values?: Record<string, string>;
    }) => {
      const added = await call(api.addCustomApp, input);
      if (values) {
        await call(api.connectApp, { appId: added.appId, values }).catch(reportFailure.onError);
      }
      return added;
    },
  });
}

export function useAddCustomSkill() {
  return useMutation({
    ...reportFailure,
    mutationFn: (source: string) => call(api.addCustomSkill, { source }, SLOW_WRITE),
  });
}

/** Download a skill again: after a failed install, or to move to the catalog's newer version. */
export function useUpdateSkill() {
  return useMutation({
    ...reportFailure,
    mutationFn: (skillId: string) => call(api.updateSkill, { skillId }),
  });
}

/**
 * A skill's SKILL.md for its page: the installed copy, else GitHub at the
 * pinned commit. Keyed by the installed commit so a reinstall reads afresh.
 */
export function useSkillContent(skillId: string, installedRef: string | null) {
  return useQuery({
    queryKey: integrationKeys.skillContent(skillId, installedRef),
    queryFn: () => call(api.skillContent, { skillId }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
