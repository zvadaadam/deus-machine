export type OnboardingStep = 0 | 1 | 2 | 3 | 4;

export interface CliCheckResult {
  installed: boolean;
  path: string | null;
  webMode?: boolean;
}

export interface GhAuthResult {
  authenticated: boolean;
  username: string | null;
}

export type { RecentProject } from "@shared/types/onboarding";
