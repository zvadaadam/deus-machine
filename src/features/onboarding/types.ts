export type OnboardingStep = 0 | 1 | 2 | 3;

export interface CliCheckResult {
  installed: boolean;
  path: string | null;
  webMode?: boolean;
}

export interface GhAuthResult {
  authenticated: boolean;
  username: string | null;
}

export interface RecentProject {
  path: string;
  name: string;
  source: "cursor" | "vscode" | "claude";
}
