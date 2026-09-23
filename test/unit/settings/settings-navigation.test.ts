import { beforeEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({
  cloudDirect: false,
  capabilities: { browserProfileImport: true, deusCloudSignIn: true },
}));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: () => mode.cloudDirect }));
vi.mock("@/platform/capabilities", () => ({ capabilities: mode.capabilities }));

import {
  settingsNavigation,
  isSettingsSectionAvailable,
  resolveSettingsSection,
} from "@/features/settings/settings-navigation";
import { staticCommands } from "@/features/command-palette/commands";

beforeEach(() => {
  mode.cloudDirect = false;
  mode.capabilities.browserProfileImport = true;
  mode.capabilities.deusCloudSignIn = true;
});

describe("settings navigation", () => {
  it("uses the same available sections for the sidebar, fallback, and palette on hosted web", () => {
    mode.cloudDirect = true;
    expect(settingsNavigation.filter(isSettingsSectionAvailable).map((item) => item.id)).toEqual([
      "account",
      "ai",
      "environment",
      "slack",
    ]);
    expect(resolveSettingsSection("general").id).toBe("account");
    expect(resolveSettingsSection("ai").id).toBe("ai");
    expect(
      staticCommands
        .filter((command) => command.group === "settings" && command.when?.())
        .map((command) => command.id)
    ).toEqual(["settings-account", "settings-ai", "settings-environment", "settings-slack"]);
  });

  it("offers Slack only where this window can hold the person's own Deus Cloud session", () => {
    const slack = settingsNavigation.find((item) => item.id === "slack")!;
    expect(isSettingsSectionAvailable(slack)).toBe(true); // desktop app
    mode.capabilities.deusCloudSignIn = false; // a relay visit, or plain local web
    expect(isSettingsSectionAvailable(slack)).toBe(false);
    mode.cloudDirect = true; // the hosted web app signs in itself
    expect(isSettingsSectionAvailable(slack)).toBe(true);
  });

  it("keeps desktop sections and gates browser settings by the actual capability", () => {
    expect(resolveSettingsSection("general").id).toBe("general");
    expect(resolveSettingsSection("browser").id).toBe("browser");
    mode.capabilities.browserProfileImport = false;
    expect(resolveSettingsSection("browser").id).toBe("account");
    expect(staticCommands.find((command) => command.id === "settings-browser")?.when?.()).toBe(
      false
    );
  });
});
