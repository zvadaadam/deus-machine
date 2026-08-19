/**
 * "Set up cloud environment" quick action — shown above the composer in cloud
 * workspaces whose repository has no specialized environment yet (the
 * workspace is running on the inline default). One click sends the
 * explore→verify→persist prompt; the agent calls agnt_configure_environment,
 * and every FUTURE workspace for this repo provisions with the result.
 */

import { useQuery } from "@tanstack/react-query";
import { Wrench, ArrowRight } from "lucide-react";
import { apiClient } from "@/shared/api/client";
import { CONFIGURE_CLOUD_ENV } from "../lib/sessionPrompts";

interface CloudEnvironmentInfo {
  configured: boolean;
  name: string | null;
  requiredEnv?: string[];
}

export function CloudEnvSetupChip({
  repositoryId,
  onSend,
}: {
  repositoryId?: string | null;
  onSend: (content: string) => void;
}) {
  const info = useQuery({
    queryKey: ["repo-cloud-environment", repositoryId],
    queryFn: () => apiClient.get<CloudEnvironmentInfo>(`/repos/${repositoryId}/cloud-environment`),
    enabled: Boolean(repositoryId),
    staleTime: 60_000,
    retry: false,
  });

  if (!repositoryId || !info.data || info.data.configured) return null;

  return (
    <button
      type="button"
      onClick={() => onSend(CONFIGURE_CLOUD_ENV)}
      className="border-border-secondary text-text-muted hover:text-text-secondary hover:border-border mb-2 flex w-fit items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-xs transition-colors duration-150"
    >
      <Wrench className="h-3 w-3" />
      <span>Set up your cloud environment</span>
      <ArrowRight className="h-3 w-3" />
    </button>
  );
}
