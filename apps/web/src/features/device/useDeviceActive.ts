import { useCloudSimulatorStore } from "./cloud/cloudSimulatorStore";

export function useDeviceActive(workspaceId: string) {
  return useCloudSimulatorStore((state) => state.byWorkspace[workspaceId]?.status === "ready");
}
