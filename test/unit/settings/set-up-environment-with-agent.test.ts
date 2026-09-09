import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetUpEnvironmentWithAgent } from "@/features/settings/ui/sections/SetUpEnvironmentWithAgent";
import type { ProviderAccounts } from "@shared/types/provider-account";

const state = vi.hoisted(() => ({
  data: undefined as ProviderAccounts | undefined,
  isError: false,
  isPending: false,
}));
vi.mock("@/features/settings/api/provider-accounts.queries", () => ({
  useProviderAccounts: () => state,
}));
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({ data: { signedIn: true, hasPlatformKey: true } }),
}));
vi.mock("@/shared/stores/uiStore", () => ({
  useUIStore: () => vi.fn(),
}));

beforeEach(() => {
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

const render = () =>
  renderToStaticMarkup(createElement(SetUpEnvironmentWithAgent, { repoId: "repo-a" }));

describe("environment setup provider readiness", () => {
  it("uses the connected personal Claude default", () => {
    expect(render()).toContain("Set up with agent");
    expect(render()).not.toContain('disabled=""');
  });
  it.each(["codex only", "deleted default", "reconnect required"])(
    "keeps Claude setup disabled with %s",
    (scenario) => {
      if (scenario === "codex only") {
        state.data!.accounts[0].provider = "codex";
        state.data!.defaultAccountIds = { codex: "claude-a" };
      }
      if (scenario === "deleted default") state.data!.defaultAccountIds.claude = "deleted-id";
      if (scenario === "reconnect required") state.data!.accounts[0].status = "reconnect_required";
      expect(render()).toContain("Connect a Claude account");
      expect(render()).toContain('disabled=""');
    }
  );
  it("waits for personal metadata and reports lookup failures", () => {
    state.data = undefined;
    state.isPending = true;
    expect(render()).toContain("Checking your AI accounts");
    expect(render()).toContain('disabled=""');
    state.isPending = false;
    state.isError = true;
    expect(render()).toContain("check your AI accounts");
    expect(render()).toContain('disabled=""');
  });
});
