import { useQuery } from "@tanstack/react-query";
import type { DeviceSupport } from "@shared/types/device-hub";
import { deviceSupport } from "@shared/api/device-hub";
import { call } from "@/platform/ws";
import { getDeploymentMode, type DeploymentMode } from "@/shared/config/backend.config";

export function localDeviceRenderer(mode: DeploymentMode) {
  return mode === "electron" || mode === "web-dev";
}

export function useDeviceSupport({ enabled = true, refreshSetup = false } = {}) {
  const mode = getDeploymentMode();
  return useQuery({
    queryKey: ["deviceSupport"],
    queryFn: () => call(deviceSupport),
    enabled: enabled && mode !== "web-direct",
    staleTime: 60_000,
    refetchOnMount: "always",
    // Following deviceHubStatus would start the hub just by opening Settings.
    refetchInterval: (q) => {
      const data = q.state.data;
      return refreshSetup && data?.liveView === "available" && data.setup === "working"
        ? 1000
        : false;
    },
    select: (data): DeviceSupport => (localDeviceRenderer(mode) ? data : { liveView: "remote" }),
  });
}
