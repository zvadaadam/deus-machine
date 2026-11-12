import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { native } from "@/platform";

export const OnboardingService = {
  /** Start GitHub auth through the browser flow using the resolved gh executable. */
  startGhAuthLogin: native.cli.startGhAuthLogin,

  /** Persist onboarding_completed=true to settings. */
  async completeOnboarding(): Promise<void> {
    await call(api.saveSetting, { key: "onboarding_completed", value: true });
  },
};
