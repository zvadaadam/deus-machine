import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SetUpEnvironmentWithAgent } from "@/features/settings/ui/sections/SetUpEnvironmentWithAgent";
import type { ProviderAccounts } from "@shared/types/provider-account";

const state = vi.hoisted(() => ({
  data: undefined as ProviderAccounts | undefined,
  model: "claude-code:claude-fable-5",
  hasPlatformKey: true,
  isError: false,
  isPending: false,
}));
vi.mock("@/features/settings/api/provider-accounts.queries", () => ({
  useProviderAccounts: () => state,
}));
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({ data: { signedIn: true, hasPlatformKey: state.hasPlatformKey } }),
}));
vi.mock("@/features/session/lib/modelPreference", () => ({
  getStoredModel: () => state.model,
}));
vi.mock("@/shared/stores/uiStore", () => ({
  useUIStore: () => vi.fn(),
}));

beforeEach(() => {
  state.model = "claude-code:claude-fable-5";
  state.hasPlatformKey = true;
  state.isError = false;
  state.isPending = false;
  state.data = {
    providers: [],
    defaultAccountIds: { claude: "claude-a" },
    accounts: [
      {
        id: "claude-a",
        provider: "claude",
        authMethod: "api_key",
        status: "connected",
        label: "Work",
        email: null,
        planType: null,
        isDefault: true,
      },
    ],
  };
});

const render = (location: "local" | "cloud" = "cloud", repoId: string | undefined = "repo-a") =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SetUpEnvironmentWithAgent, {
        repoId,
        location,
        activeOrganization: true,
        onBeforeStart: () => true,
      })
    )
  );

describe("environment setup provider readiness", () => {
  it("uses the connected personal Claude default", () => {
    expect(render()).toContain("Set up with agent");
    expect(render()).not.toContain('disabled=""');
  });
  it("supports the selected Codex model without requiring Claude", () => {
    state.model = "codex-app-server:gpt-6-astra";
    state.data!.accounts[0].provider = "codex";
    state.data!.defaultAccountIds = { codex: "claude-a" };
    expect(render()).not.toContain('disabled=""');
  });
  it.each(["different provider", "deleted default", "reconnect required"])(
    "blocks cloud setup with %s",
    (scenario) => {
      if (scenario === "different provider") state.model = "codex-app-server:gpt-6-astra";
      if (scenario === "deleted default") state.data!.defaultAccountIds.claude = "deleted-id";
      if (scenario === "reconnect required") state.data!.accounts[0].status = "reconnect_required";
      expect(render()).toContain('disabled=""');
    }
  );
  it("blocks cloud setup while accounts cannot be checked", () => {
    state.data = undefined;
    state.isPending = true;
    expect(render()).toContain('disabled=""');
    state.isPending = false;
    state.isError = true;
    expect(render()).toContain('disabled=""');
  });
  it("lets local setup use local authentication without a cloud account", () => {
    state.hasPlatformKey = false;
    state.data = undefined;
    state.isError = true;
    expect(render("local")).not.toContain('disabled=""');
    expect(render("cloud")).toContain('disabled=""');
  });
});
