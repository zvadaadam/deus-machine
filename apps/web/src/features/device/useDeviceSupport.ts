import { useQuery } from "@tanstack/react-query";
import { deviceSupport } from "@shared/api/device-hub";
import { call } from "@/platform/ws";
import { getDeploymentMode, type DeploymentMode } from "@/shared/config/backend.config";

export function localDeviceRenderer(mode: DeploymentMode) {
  return mode === "electron" || mode === "web-dev";
}

export function useDeviceSupport(enabled = true) {
  const mode = getDeploymentMode();
  return useQuery({
    queryKey: ["deviceSupport"],
    queryFn: () => call(deviceSupport),
    enabled: enabled && mode !== "web-direct",
    staleTime: 60_000,
    refetchOnMount: "always",
    // Following deviceHubStatus would start the hub just by opening Settings.
    refetchInterval: (q) => (q.state.data?.setup === "working" ? 1000 : false),
    select: (data) =>
      localDeviceRenderer(mode) || data.liveView !== "available"
        ? data
        : { ...data, liveView: "remote" as const },
  });
}
