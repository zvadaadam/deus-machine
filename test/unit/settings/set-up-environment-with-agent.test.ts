import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SetUpEnvironmentWithAgent } from "@/features/settings/ui/sections/SetUpEnvironmentWithAgent";
import { cloudNotReady } from "@/features/settings/lib/section-organization";
import type { CloudOrganizations } from "@shared/types/environment-secrets";
import type { GatewayCatalog } from "@shared/gateways";
import type { ProviderAccounts } from "@shared/types/provider-account";

const twoOrganizations = (ready: { acme: boolean; beta: boolean }): CloudOrganizations => ({
  available: ready.acme || ready.beta,
  accountId: "alice",
  defaultOrganizationId: "org_a",
  items: [
    { id: "org_a", name: "Acme", role: "owner", ready: ready.acme },
    { id: "org_b", name: "Beta", role: "member", ready: ready.beta },
  ],
});

const state = vi.hoisted(() => ({
  data: undefined as ProviderAccounts | undefined,
  model: "claude-code:claude-fable-5" as string | undefined,
  vaultLocked: false,
  organizations: undefined as CloudOrganizations | undefined,
  isError: false,
  isPending: false,
}));
vi.mock("@/features/settings/api/provider-accounts.queries", () => ({
  useProviderAccounts: () => state,
}));
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({ data: { signedIn: true, vaultLocked: state.vaultLocked } }),
}));
vi.mock("@/shared/hooks/useCloudOrganizations", () => ({
  useCloudOrganizations: () => state.organizations,
}));
vi.mock("@/features/session/lib/modelPreference", () => ({
  getStoredModel: () => state.model,
}));
vi.mock("@/shared/stores/uiStore", () => ({
  useUIStore: () => vi.fn(),
}));
vi.mock("@/components/ui/tooltip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/tooltip")>()),
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
}));
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient();
  state.model = "claude-code:claude-fable-5";
  state.vaultLocked = false;
  state.organizations = twoOrganizations({ acme: true, beta: true });
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

const render = (
  location: "local" | "cloud" = "cloud",
  repoId: string | undefined = "repo-a",
  organizationId: string | null = "org_a"
) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        TooltipProvider,
        null,
        createElement(SetUpEnvironmentWithAgent, {
          repoId,
          location,
          organizationId,
          onBeforeStart: () => true,
        })
      )
    )
  );

describe("environment setup provider readiness", () => {
  it("uses the connected personal Claude default", () => {
    expect(render()).toContain("Set up with agent");
    expect(render()).not.toContain('disabled=""');
  });
  it("names the gateway model by its catalog label for local setup", () => {
    state.model = "gateway:claude-code:revision:vendor/model-v2";
    client.setQueryData<GatewayCatalog[]>(
      ["gateways"],
      [
        {
          ref: "fixture",
          generation: "revision",
          preset: "custom",
          address: "https://gateway.example",
          formats: ["messages"],
          models: [{ id: "vendor/model-v2", provider: "vendor", label: "Studio Model" }],
        },
      ]
    );
    expect(render("local")).toContain("Start a local workspace with Studio Model");
  });
  it("resolves a saved local Gemini pick for cloud setup and keeps it for local setup", () => {
    state.model = "gemini:gemini-4-neon";
    const cloud = render("cloud");
    expect(cloud).not.toContain('disabled=""');
    expect(cloud).toMatch(/Start a cloud workspace with .*Opus/);
    expect(render("local")).toContain("Start a local workspace with gemini-4-neon");
  });
  it("shows the empty list's reason when a local setup has no model", () => {
    state.model = undefined;
    client.setQueryData([...queryKeys.settings.agentModels, null], {
      lists: [
        {
          harness: "claude-code",
          source: "catalog",
          models: [],
          error: "Sign in on this computer.",
        },
      ],
    });
    const local = render("local");
    expect(local).toContain('disabled=""');
    expect(local).toContain("Sign in on this computer.");
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
    state.organizations = twoOrganizations({ acme: false, beta: false });
    state.data = undefined;
    state.isError = true;
    expect(render("local")).not.toContain('disabled=""');
    expect(render("cloud")).toContain('disabled=""');
  });
});

describe("environment setup in an organization", () => {
  it("starts in any organization that is ready here, not only the default one", () => {
    expect(render("cloud", "repo-a", "org_b")).not.toContain('disabled=""');
  });
  it("blocks an organization that is not set up on this computer", () => {
    state.organizations = twoOrganizations({ acme: true, beta: false });
    expect(render("cloud", "repo-a", "org_b")).toContain('disabled=""');
    expect(render("cloud", "repo-a", "org_a")).not.toContain('disabled=""');
    expect(cloudNotReady(state.organizations, "org_b")).toBe(
      "Beta is not set up on this computer yet. Finish device setup in Settings → Cloud."
    );
    expect(cloudNotReady(state.organizations, "org_a")).toBeNull();
  });
  it("blocks while this computer's cloud is unknown, or not set up with no list", () => {
    expect(cloudNotReady(undefined, "org_a")).toContain("Checking");
    const none = { available: false, accountId: null, defaultOrganizationId: null, items: [] };
    expect(cloudNotReady(none, null)).toBe("Finish device setup in Settings → Cloud.");
    expect(cloudNotReady({ ...none, available: true }, null)).toBeNull();
  });
  it("asks to unlock a locked keyring first", () => {
    state.vaultLocked = true;
    expect(render()).toContain('disabled=""');
    expect(render("local")).not.toContain('disabled=""');
  });
});
