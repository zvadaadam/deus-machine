import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";

/** All wake controls handle HTTP failures and the route's 200 {ok:false} alike. */
export async function wakeCloudWorkspace(workspaceId: string): Promise<boolean> {
  try {
    const result = await apiClient.post<{ ok: boolean; status: string }>(
      `/workspaces/${workspaceId}/cloud-wake`
    );
    if (result.ok) return true;
    if (result.status === "running") {
      toast.error("Couldn't refresh cloud status. Your existing connection is still available.");
      return false;
    }
  } catch {
    // Network failures use the same retry affordance as a rejected wake.
  }
  toast.error("Couldn't wake your computer. Try again.");
  return false;
}
