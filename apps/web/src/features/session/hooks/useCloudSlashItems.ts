/**
 * What the `/` menu lists in a cloud chat: nothing from this computer's
 * folders (the agent does not run here), only the skills a cloud turn places
 * in the sandbox (Customize installs, while cloud turns carry them).
 */
import { useMemo } from "react";
import { useIntegrations } from "@/features/customize/api/integrations.queries";
import type { SlashCommandItem } from "./useSlashCommand";

export function useCloudSlashItems(enabled: boolean): SlashCommandItem[] {
  const { data } = useIntegrations({ enabled });
  return useMemo(
    () =>
      (enabled ? (data?.skills ?? []) : [])
        .filter((view) => view.cloud)
        .map((view) => ({
          name: view.skill.name,
          description: view.skill.description,
          kind: "skill" as const,
        })),
    [enabled, data]
  );
}
