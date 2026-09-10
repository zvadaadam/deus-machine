import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectEnvironment } from "@deus-hq/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryEnvironmentSettings } from "@/features/settings/ui/sections/RepositoryEnvironmentSettings";
import type { EnvironmentRepository } from "@/features/settings/lib/environment-repositories";
import type { CloudEnvironmentSettings } from "@shared/types/environment-secrets";

const queries = vi.hoisted(() => ({
  settings: {
    data: undefined as CloudEnvironmentSettings | undefined,
    isError: false,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  file: {
    data: undefined as { project: ProjectEnvironment | null; branch: string } | undefined,
    isError: false,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey.includes("file") ? queries.file : queries.settings,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useLayoutEffect: react.useEffect };
});
vi.mock("@/features/repository/api/repository.service", () => ({ RepoService: {} }));
vi.mock("@/features/settings/api/environment-secrets.service", () => ({}));
vi.mock("@/features/settings/ui/sections/ConnectEnvironmentRepositories", () => ({
  ConnectEnvironmentRepositories: () => null,
}));
vi.mock("@/features/settings/ui/sections/EnvironmentSecretDialog", () => ({
  EnvironmentSecretDialog: () => null,
}));
vi.mock("@/features/settings/ui/sections/ImportEnvironmentSecretsDialog", () => ({
  ImportEnvironmentSecretsDialog: () => null,
}));

const repository: EnvironmentRepository = {
  key: "https://github.com/acme/app",
  name: "acme/app",
  repo: "https://github.com/acme/app",
  local: {
    id: "local-repository",
    name: "app",
    root_path: "/projects/app",
    git_default_branch: "main",
    git_origin_url: "https://github.com/acme/app",
  },
  environment: {
    id: "environment",
    name: "app",
    repo: "https://github.com/acme/app",
    ownerType: "ORG",
    isRepositoryDefault: true,
  },
};

beforeEach(() => {
  queries.settings.data = {
    accountId: "account",
    organizationId: "org",
    canManageShared: true,
    selectedEnvironment: {
      id: "environment",
      project: { version: 1, setup: "echo saved", requiredEnv: ["SAVED_REQUIRED"] },
      canEdit: true,
    },
    environments: [repository.environment!],
    secrets: [],
    required: [{ name: "SAVED_REQUIRED", source: null, secretId: null }],
  };
  queries.settings.isError = false;
  queries.settings.isLoading = false;
  queries.settings.error = null;
  queries.file.data = { project: null, branch: "main" };
  queries.file.isError = false;
  queries.file.isLoading = false;
  queries.file.error = null;
});

const render = () =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(RepositoryEnvironmentSettings, {
        accountId: "account",
        orgId: "org",
        repository,
        access: true,
        accessUnknown: false,
        onDirtyChange: () => {},
        onDefaults: () => {},
      })
    )
  );

describe("repository environment sources", () => {
  it("keeps Required values and Set value actions for an explicit SDK environment", () => {
    queries.settings.data!.selectedEnvironment!.project = null;
    queries.settings.data!.selectedEnvironment!.canEdit = false;
    const html = render();
    expect(html).toContain("configured through the SDK");
    expect(html).toContain("Required values");
    expect(html).toContain("SAVED_REQUIRED");
    expect(html).toContain("Set value");
    expect(html).not.toContain('aria-label="Project environment"');
  });

  it("does not revive saved requirements when the repository recipe has no required names", () => {
    queries.file.data!.project = { version: 1, requiredEnv: [] };
    const html = render();
    expect(html).toContain('aria-label="Project environment"');
    expect(html).not.toContain("Required values");
    expect(html).not.toContain("SAVED_REQUIRED");
  });

  it("keeps a successfully loaded local file editable when cloud settings fail", () => {
    queries.file.data!.project = { version: 1, setup: "echo local" };
    queries.settings.isError = true;
    queries.settings.error = new Error("Cloud settings unavailable");
    const html = render();
    expect(html).toContain('aria-label="Project environment"');
    expect(html).toContain("echo local");
    expect(html).toMatch(/<fieldset(?![^>]*\bdisabled\b)[^>]*>/);
    expect(html).toContain("Cloud settings unavailable");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Cloud secrets");
    expect(html).not.toContain("echo saved");
  });

  it("keeps the loaded local editor mounted while cloud settings retry without cached data", () => {
    queries.file.data!.project = { version: 1, setup: "echo local" };
    queries.settings.data = undefined;
    queries.settings.isLoading = true;
    const html = render();
    expect(html).toContain('aria-label="Project environment"');
    expect(html).toContain("echo local");
    expect(html).toMatch(/<fieldset(?![^>]*\bdisabled\b)[^>]*>/);
    expect(html).toContain("Loading cloud secrets");
    expect(html).not.toContain("Loading project environment");
    expect(html).not.toContain("Sign in to manage cloud secrets");
  });

  it("waits for saved defaults when cloud settings load and the local file is absent", () => {
    queries.settings.data = undefined;
    queries.settings.isLoading = true;
    const html = render();
    expect(html).toContain("Loading project environment");
    expect(html).not.toContain('aria-label="Project environment"');
  });

  it("does not replace unknown saved defaults with an empty editor when the local file is absent", () => {
    queries.settings.isError = true;
    queries.settings.error = new Error("Cloud settings unavailable");
    const html = render();
    expect(html).toContain("Cloud settings unavailable");
    expect(html).not.toContain('aria-label="Project environment"');
  });

  it("blocks a failed file lookup even when cached file data and saved defaults exist", () => {
    queries.file.data!.project = { version: 1, setup: "echo cached" };
    queries.file.isError = true;
    queries.file.error = new Error("Invalid .deus/environment.json");
    const html = render();
    expect(html).toContain("Invalid .deus/environment.json");
    expect(html).not.toContain('aria-label="Project environment"');
    expect(html).not.toContain("echo saved");
    expect(html).not.toContain("echo cached");
  });
});
