import { api } from "@shared/api";
import { call } from "@/platform/ws";

export const OnboardingService = {
  /** Persist onboarding_completed=true to settings. */
  async completeOnboarding(): Promise<void> {
    await call(api.saveSetting, { key: "onboarding_completed", value: true });
  },
};
