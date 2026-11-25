import { useCloudSimulatorStore } from "./cloud/cloudSimulatorStore";
import { useSimulatorStatusStore } from "./store";

export function useSimulatorActive(workspaceId: string) {
  const phase = useSimulatorStatusStore((state) => state.phases[workspaceId]);
  const cloudReady = useCloudSimulatorStore(
    (state) => state.byWorkspace[workspaceId]?.status === "ready"
  );
  return (!!phase && phase !== "idle" && phase !== "error") || cloudReady;
}
