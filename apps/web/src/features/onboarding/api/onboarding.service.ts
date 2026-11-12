import { sendMutate } from "@/platform/ws";
import { native } from "@/platform";

export const OnboardingService = {
  /** Start GitHub auth through the browser flow using the resolved gh executable. */
  startGhAuthLogin: native.cli.startGhAuthLogin,

  /** Persist onboarding_completed=true to settings. */
  async completeOnboarding(): Promise<void> {
    const result = await sendMutate("saveSetting", {
      key: "onboarding_completed",
      value: true,
    });
    if (!result.success) throw new Error(result.error || "Failed to complete onboarding");
  },
};
