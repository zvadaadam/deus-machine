export type OnboardingStep = 0 | 1 | 2 | 3 | 4;

// CLI types live in the platform native layer (single source of truth)
export type { CliCheckResult } from "@/platform/native/cli";

export type { RecentProject } from "@shared/types/onboarding";
