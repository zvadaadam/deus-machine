/**
 * First-run onboarding wizard for headless mode.
 *
 * Two steps:
 * 1. AI Agent setup (Claude CLI detection + auth)
 * 2. Remote access configuration
 *
 * Only runs once — completion is tracked in ~/.config/deus/config.json.
 */

import { runAuthSetup, type AuthResult } from "./login.js";
import { loadConfig, saveConfig, hasCompletedOnboarding } from "./config.js";
import { confirm } from "./prompt.js";
import { c, divider, blank, success, hint } from "./ui.js";

interface OnboardingResult {
  auth: AuthResult;
  relayEnabled: boolean;
}

export async function runOnboarding(): Promise<OnboardingResult> {
  // Already completed — return saved config
  if (hasCompletedOnboarding()) {
    const config = loadConfig();
    return {
      auth: {
        method: (config.auth_method as AuthResult["method"]) || "skipped",
        apiKey: config.anthropic_api_key,
      },
      relayEnabled: config.relay_enabled,
    };
  }

  hint("Welcome to Deus! Let's get you set up.");
  blank();

  // ── Step 1: AI Agent ───────────────────────────────────────────────
  divider("Step 1 of 2 — AI Agent");
  blank();

  const auth = await runAuthSetup({ force: true });

  // ── Step 2: Remote Access ──────────────────────────────────────────
  divider("Step 2 of 2 — Remote Access");
  blank();

  hint("Access Deus from your phone or another");
  hint(`computer via ${c.cyan(c.underline("app.deusmachine.ai"))}`);
  blank();

  const relayEnabled = await confirm({
    message: "Enable remote access?",
    default: true,
  });

  if (relayEnabled) {
    success("Remote access enabled");
  } else {
    hint("Remote access disabled. You can enable it later in Settings.");
  }
  blank();

  // ── Save config ────────────────────────────────────────────────────
  const config = loadConfig();
  config.onboarding_completed = true;
  config.relay_enabled = relayEnabled;
  config.installed_at = new Date().toISOString();
  saveConfig(config);

  // ── Done ───────────────────────────────────────────────────────────
  divider("All set!");
  blank();

  return { auth, relayEnabled };
}
