import { sendRequest, sendMutate } from "@/platform/ws";
import { native } from "@/platform";
import type { RecentProject } from "../types";

export const OnboardingService = {
  /** Check if a CLI tool is installed. Returns safe default on failure or in web mode. */
  checkCliTool: native.cli.checkCliTool,

  /** Check GitHub CLI auth status. Returns unauthenticated on failure or in web mode. */
  checkGhAuth: native.cli.checkGhAuth,

  /** Fetch recent projects from Cursor, VS Code, and Claude directories. */
  async fetchRecentProjects(): Promise<{ projects: RecentProject[] }> {
    return sendRequest<{ projects: RecentProject[] }>("recentProjects");
  },

  /** Persist onboarding_completed=true to settings. */
  async completeOnboarding(): Promise<void> {
    const result = await sendMutate("saveSetting", {
      key: "onboarding_completed",
      value: true,
    });
    if (!result.success) throw new Error(result.error || "Failed to complete onboarding");
  },
};
