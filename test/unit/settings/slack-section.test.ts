import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SlackSection } from "@/features/settings/ui/sections/SlackSection";
import { queryKeys } from "@/shared/api/queryKeys";

const providerState = vi.hoisted(() => ({
  error: null as Error | null,
  data: {} as {
    providers: Array<{
      id: "claude";
      name: string;
      vendor: string;
      authMethods: Array<"subscription">;
    }>;
    accounts: Array<{
      id: string;
      provider: "claude";
      authMethod: "subscription";
      label: string;
      email: null;
      planType: null;
      status: "connected";
      isDefault: boolean;
    }>;
    defaultAccountIds: { claude?: string };
  },
}));

function defaultProviderData() {
  return {
    providers: [
      { id: "claude", name: "Claude", vendor: "Anthropic", authMethods: ["subscription"] },
    ],
    accounts: [
      {
        id: "claude-account",
        provider: "claude",
        authMethod: "subscription",
        label: "Member Claude",
        email: null,
        planType: null,
        status: "connected",
        isDefault: true,
      },
    ],
    defaultAccountIds: { claude: "claude-account" },
  } satisfies typeof providerState.data;
}

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useLayoutEffect: react.useEffect };
});
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({
    data: { signedIn: true, accountId: "account" },
    isPending: false,
  }),
}));
vi.mock("@/shared/hooks/useDeusCloudSignIn", () => ({
  useDeusCloudSignIn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/platform", () => ({ native: { window: { openExternal: vi.fn() } } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/features/settings/api/provider-accounts.queries", () => ({
  PROVIDER_ACCOUNTS_QUERY_KEY: ["settings", "provider-accounts"],
  useProviderAccounts: () => ({
    accountId: "account",
    data: providerState.error ? undefined : providerState.data,
    isLoading: false,
    isFetching: false,
    isError: providerState.error !== null,
    error: providerState.error,
    refetch: vi.fn(),
  }),
}));

let client: QueryClient;

function seedBase() {
  client.setQueryData(queryKeys.settings.environments.organizations("account"), {
    accountId: "account",
    currentOrganizationId: "org",
    items: [{ id: "org", name: "Organization", role: "owner" }],
  });
  client.setQueryData(queryKeys.settings.slack.organization("account", "org"), {
    id: "org",
    name: "Organization",
    companyModelAccount: null,
  });
  client.setQueryData(queryKeys.settings.environments.detail("account", "org", null), {
    accountId: "account",
    organizationId: "org",
    canManageShared: true,
    selectedEnvironment: null,
    environments: [
      {
        id: "env",
        name: "Backend",
        repo: "acme/backend",
        description: "API and database migrations",
        ownerType: "ORG",
        isRepositoryDefault: false,
      },
    ],
    secrets: [],
    required: [],
  });
}

beforeEach(() => {
  client = new QueryClient();
  providerState.data = defaultProviderData();
  providerState.error = null;
  seedBase();
});

afterEach(() => {
  client.clear();
});

const render = () =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SlackSection)));

it("shows the deployment-not-configured workspace state", () => {
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: false,
    installations: [],
  });
  expect(render()).toContain("Slack isn&#x27;t set up for this Deus deployment yet.");
});

it("shows the connect action when Slack is configured but not installed", () => {
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: true,
    installations: [],
  });
  const html = render();
  expect(html).toContain("Connect Slack");
  expect(html).toContain("You&#x27;ll confirm in your browser");
});

it("shows installed workspaces with disconnect actions", () => {
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: true,
    installations: [
      {
        id: "install",
        teamIdentifier: "T1",
        teamName: "Acme Slack",
        installedBy: { accountId: "member", name: "Ada" },
        createdAt: "2026-01-02T00:00:00Z",
      },
    ],
  });
  const html = render();
  expect(html).toContain("Acme Slack");
  expect(html).toContain("Disconnect");
});

it("shows a shared Claude account", () => {
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: true,
    installations: [],
  });
  client.setQueryData(queryKeys.settings.slack.organization("account", "org"), {
    id: "org",
    name: "Organization",
    companyModelAccount: { accountId: "member", name: "Ada" },
  });
  const html = render();
  expect(html).toContain("Ada&#x27;s Claude account");
  expect(html).toContain("Stop sharing");
});

it("offers to share the current member's Claude account when none is shared", () => {
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: true,
    installations: [],
  });
  const html = render();
  expect(html).toContain("No shared account yet.");
  expect(html).toContain("Share my Claude account");
});

it("guides members without a Claude account to AI settings", () => {
  providerState.data = {
    ...providerState.data,
    accounts: [],
    defaultAccountIds: {},
  };
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: true,
    installations: [],
  });
  const html = render();
  expect(html).toContain("Connect a Claude account first");
  expect(html).toContain("Open AI settings");
});

it("shows a failed Claude-account lookup as an error, not as a missing account", () => {
  providerState.error = new Error("Couldn't load AI accounts.");
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: true,
    installations: [],
  });
  const html = render();
  expect(html).toContain("Couldn&#x27;t load AI accounts.");
  expect(html).not.toContain("Connect a Claude account first");
});

it("shows repository descriptions read-only for non-admins", () => {
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: true,
    installations: [],
  });
  client.setQueryData(queryKeys.settings.environments.detail("account", "org", null), {
    accountId: "account",
    organizationId: "org",
    canManageShared: false,
    selectedEnvironment: null,
    environments: [
      {
        id: "env",
        name: "Backend",
        repo: "acme/backend",
        description: "API and database migrations",
        ownerType: "ORG",
        isRepositoryDefault: false,
      },
    ],
    secrets: [],
    required: [],
  });
  const html = render();
  expect(html).toContain("Only owners and admins can edit descriptions.");
  expect(html).toContain("API and database migrations");
  expect(html).not.toContain(">Save</button>");
});
