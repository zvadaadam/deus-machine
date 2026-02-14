import { apiClient } from "@/shared/api/client";
import { invoke, isTauriEnv } from "@/platform/tauri";
import type { CliCheckResult, GhAuthResult, RecentProject } from "../types";

export const OnboardingService = {
  /** Check if a CLI tool is installed. Returns safe default on failure or in web mode. */
  async checkCliTool(name: string): Promise<CliCheckResult> {
    if (!isTauriEnv) {
      return { installed: false, path: null, webMode: true };
    }
    try {
      return await invoke<CliCheckResult>("check_cli_tool", { name });
    } catch {
      return { installed: false, path: null };
    }
  },

  /** Check GitHub CLI auth status. Returns unauthenticated on failure or in web mode. */
  async checkGhAuth(): Promise<GhAuthResult> {
    if (!isTauriEnv) {
      return { authenticated: false, username: null };
    }
    try {
      return await invoke<GhAuthResult>("check_gh_auth");
    } catch {
      return { authenticated: false, username: null };
    }
  },

  /** Fetch recent projects from Cursor, VS Code, and Claude directories. */
  async fetchRecentProjects(): Promise<{ projects: RecentProject[] }> {
    return apiClient.get<{ projects: RecentProject[] }>("/onboarding/recent-projects");
  },

  /** Persist onboarding_completed=true to settings. */
  async completeOnboarding(): Promise<void> {
    await apiClient.post("/settings", { key: "onboarding_completed", value: true });
  },
};
