import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentSection } from "@/features/settings/ui/sections/EnvironmentSection";
import type { ProviderAccounts } from "@shared/types/provider-account";

const state = vi.hoisted(() => ({
  data: undefined as ProviderAccounts | undefined,
  isError: false,
}));
vi.mock("@/features/settings/api/provider-accounts.queries", () => ({
  useProviderAccounts: () => state,
}));
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({ data: { signedIn: true, hasPlatformKey: true } }),
}));
vi.mock("@/features/repository", () => ({
  useRepos: () => ({ data: [{ id: "repo-a", name: "Repo" }] }),
  useRepoManifest: () => ({ data: null }),
  useSaveRepoManifest: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/repository/api/repository.service", () => ({ RepoService: {} }));
vi.mock("@/features/settings/ui/sections/WorkspaceStatusDashboard", () => ({
  WorkspaceStatusDashboard: () => null,
}));
vi.mock("@/features/settings/ui/sections/CloudEnvironmentBlock", () => ({
  CloudEnvironmentBlock: ({ cloudBlockedReason }: { cloudBlockedReason: string | null }) =>
    createElement("p", null, cloudBlockedReason ?? "Setup ready"),
}));

beforeEach(() => {
  state.isError = false;
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

const render = () => renderToStaticMarkup(createElement(EnvironmentSection));

describe("environment setup provider readiness", () => {
  it("uses the connected personal Claude default", () => {
    expect(render()).toContain("Setup ready");
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
      expect(render()).toContain("Choose a connected Claude account");
      expect(render()).not.toContain("Setup ready");
    }
  );
  it("waits for personal metadata and reports lookup failures", () => {
    state.data = undefined;
    expect(render()).toContain("Checking provider accounts");
    state.isError = true;
    expect(render()).toContain("check your provider accounts");
  });
});
