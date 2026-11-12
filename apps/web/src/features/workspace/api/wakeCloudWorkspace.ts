import { toast } from "sonner";
import { api } from "@shared/api";
import { call } from "@/platform/ws";

/** All wake controls handle a refused request and an answered `{ ok: false }` alike. */
export async function wakeCloudWorkspace(workspaceId: string): Promise<boolean> {
  try {
    const result = await call(api.wakeCloudWorkspace, { workspaceId });
    if (result.ok) return true;
    if (result.error) {
      toast.error(result.error);
      return false;
    }
    if (result.status === "running") {
      toast.error("Couldn't refresh cloud status. Your existing connection is still available.");
      return false;
    }
  } catch (err) {
    if (err instanceof Error) {
      toast.error(err.message);
      return false;
    }
  }
  toast.error("Couldn't wake your computer. Try again.");
  return false;
}
