import { apiClient } from "@/shared/api/client";
import { invoke, isTauriEnv } from "@/platform/tauri";
import type { CliCheckResult, GhAuthResult, RecentProject } from "../types";

export const OnboardingService = {
  async checkCliTool(name: string): Promise<CliCheckResult> {
    if (!isTauriEnv) {
      return { installed: false, path: null, webMode: true };
    }
    return invoke<CliCheckResult>("check_cli_tool", { name });
  },

  async checkGhAuth(): Promise<GhAuthResult> {
    if (!isTauriEnv) {
      return { authenticated: false, username: null };
    }
    return invoke<GhAuthResult>("check_gh_auth");
  },

  async fetchRecentProjects(): Promise<{ projects: RecentProject[] }> {
    return apiClient.get<{ projects: RecentProject[] }>("/onboarding/recent-projects");
  },

  async completeOnboarding(): Promise<void> {
    await apiClient.post("/settings", { key: "onboarding_completed", value: true });
  },
};
