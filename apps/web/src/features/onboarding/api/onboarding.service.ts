import { apiClient } from "@/shared/api/client";
import { native } from "@/platform";
import type { RecentProject } from "../types";

export const OnboardingService = {
  /** Check if a CLI tool is installed. Returns safe default on failure or in web mode. */
  checkCliTool: native.cli.checkCliTool,

  /** Check GitHub CLI auth status. Returns unauthenticated on failure or in web mode. */
  checkGhAuth: native.cli.checkGhAuth,

  /** Fetch recent projects from Cursor, VS Code, and Claude directories. */
  async fetchRecentProjects(): Promise<{ projects: RecentProject[] }> {
    return apiClient.get<{ projects: RecentProject[] }>("/onboarding/recent-projects");
  },

  /** Persist onboarding_completed=true to settings. */
  async completeOnboarding(): Promise<void> {
    await apiClient.post("/settings", { key: "onboarding_completed", value: true });
  },
};
