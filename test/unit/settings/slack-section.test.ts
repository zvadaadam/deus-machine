import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SlackSection } from "@/features/settings/ui/sections/SlackSection";
import { queryKeys } from "@/shared/api/queryKeys";

const sessionState = vi.hoisted(() => ({
  data: { signedIn: true, accountId: "account" } as {
    signedIn: boolean;
    accountId: string | null;
    vaultLocked?: boolean;
  },
  isError: false,
}));

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
    data: sessionState.isError ? undefined : sessionState.data,
    isPending: false,
    isError: sessionState.isError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/shared/hooks/useDeusCloudSignIn", () => ({
  useDeusCloudSignIn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/platform", () => ({
  native: { window: { openExternal: vi.fn(), onFocus: () => () => {} } },
}));
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
  sessionState.data = { signedIn: true, accountId: "account" };
  sessionState.isError = false;
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
  expect(html).toContain(">Connect workspace</button>");
  expect(html).toContain("No workspace connected yet. You&#x27;ll confirm in your browser");
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
  expect(html).toContain('aria-label="Disconnect Acme Slack"');
  expect(html).toContain(">Connect workspace</button>");
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

function seedEnvironments(
  environments: Array<{
    id: string;
    name: string;
    repo: string | null;
    description: string | null;
  }>,
  canManageShared = true
) {
  client.setQueryData(queryKeys.settings.slack.installations("account", "org"), {
    configured: true,
    installations: [],
  });
  client.setQueryData(queryKeys.settings.environments.detail("account", "org", null), {
    accountId: "account",
    organizationId: "org",
    canManageShared,
    selectedEnvironment: null,
    environments: environments.map((environment) => ({
      ...environment,
      ownerType: "ORG",
      isRepositoryDefault: false,
    })),
    secrets: [],
    required: [],
  });
}

it("lists described environments as routing rules, and only those", () => {
  seedEnvironments([
    {
      id: "backend",
      name: "Backend",
      repo: "https://github.com/acme/backend.git",
      description: "API and database migrations",
    },
    { id: "web", name: "Web", repo: "https://github.com/acme/web", description: null },
  ]);
  const html = render();
  expect(html).toContain(">Description</th>");
  expect(html).toContain(">Target</th>");
  expect(html).toContain("API and database migrations");
  expect(html).toContain(">acme/backend<");
  expect(html).not.toContain("acme/web");
  expect(html).toContain('aria-label="Edit the rule for acme/backend"');
  expect(html).toContain('aria-label="Delete the rule for acme/backend"');
  expect(html).toContain("line-clamp-2");
  expect(html).not.toContain("break-all");
  expect(html).toContain(">Add rule</button>");
});

it("names the environment when its repository is shared with another", () => {
  seedEnvironments([
    { id: "a", name: "qapp-staging", repo: "https://github.com/acme/qapp", description: "Staging" },
    { id: "b", name: "qapp-prod", repo: "https://github.com/acme/qapp", description: "Production" },
  ]);
  const html = render();
  expect(html).toContain(">qapp-staging<");
  expect(html).toContain(">qapp-prod<");
  // Narrow, the target sits under the description and still names the repository.
  expect(html).toContain(">qapp-staging · acme/qapp<");
});

it("invites a first rule when no environment has a description", () => {
  seedEnvironments([
    { id: "web", name: "Web", repo: "https://github.com/acme/web", description: null },
  ]);
  const html = render();
  expect(html).toContain("No rules yet, so Slack requests run without a repository");
  expect(html).not.toContain("<table");
  expect(html).toContain(">Add rule</button>");
});

it("shows routing rules read-only for non-admins", () => {
  seedEnvironments(
    [
      {
        id: "backend",
        name: "Backend",
        repo: "https://github.com/acme/backend",
        description: "API and database migrations",
      },
    ],
    false
  );
  const html = render();
  expect(html).toContain("API and database migrations");
  expect(html).toContain("Only owners and admins can change routing rules.");
  // No Edit to open, so the whole description and target show.
  expect(html).not.toContain("line-clamp-2");
  expect(html).toContain("break-all");
  expect(html).not.toContain("Add rule");
  expect(html).not.toContain("Edit the rule");
  expect(html).not.toContain("Delete the rule");
});

it("asks to unlock a locked keyring instead of signing in again", () => {
  sessionState.data = { signedIn: false, accountId: null, vaultLocked: true };
  const html = render();
  expect(html).toContain("Unlock your computer&#x27;s keyring, then reopen Deus.");
  expect(html).not.toContain("Sign in to Deus Cloud");
});

it("offers a retry, not a sign-in, when the session check fails", () => {
  sessionState.isError = true;
  const html = render();
  expect(html).toContain("Couldn&#x27;t check your Deus Cloud session.");
  expect(html).toContain("Retry");
  expect(html).not.toContain("Sign in to Deus Cloud");
});

it("signed out, it offers sign-in", () => {
  sessionState.data = { signedIn: false, accountId: null };
  expect(render()).toContain("Sign in to Deus Cloud");
});
