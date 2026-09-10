import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EnvironmentSection } from "@/features/settings/ui/sections/EnvironmentSection";
import { queryKeys } from "@/shared/api/queryKeys";
import type { EnvironmentRepository } from "@/features/settings/lib/environment-repositories";

const ui = vi.hoisted(() => ({
  target: null as { repoId: string; location: "local" | "cloud" } | null,
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useLayoutEffect: react.useEffect };
});
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({ data: { signedIn: true, accountId: "account" }, isPending: false }),
}));
vi.mock("@/shared/hooks/useDeusCloudSignIn", () => ({ useDeusCloudSignIn: () => ({}) }));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: () => false }));
vi.mock("@/shared/stores/uiStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/stores/uiStore")>()),
  useUIStore: (select: (state: { environmentSettingsTarget: typeof ui.target }) => unknown) =>
    select({ environmentSettingsTarget: ui.target }),
}));
vi.mock("@/features/settings/ui/sections/RepositoryEnvironmentSettings", () => ({
  RepositoryEnvironmentSettings: ({ repository }: { repository: EnvironmentRepository }) =>
    createElement("div", { "data-selected-repository": repository.local?.id ?? repository.key }),
}));
vi.mock("@/features/settings/ui/sections/ConnectEnvironmentRepositories", () => ({
  ConnectEnvironmentRepositories: () => null,
}));
vi.mock("@/features/settings/ui/sections/SetUpEnvironmentWithAgent", () => ({
  SetUpEnvironmentWithAgent: () => null,
}));

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
  client.setQueryData(queryKeys.settings.environments.organizations("account"), {
    currentOrganizationId: "org",
    items: [{ id: "org", name: "Organization" }],
  });
  client.setQueryData(queryKeys.settings.environments.detail("account", "org", null), {
    environments: [],
  });
  client.setQueryData(queryKeys.repos.all, []);
  ui.target = null;
});
afterEach(() => {
  client.clear();
  ui.target = null;
});
const render = () =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(EnvironmentSection))
  );

it("opens the selected local repository without normalizing its opaque ID", () => {
  const id = "Local.Clone.git/";
  client.setQueryData(queryKeys.repos.all, [
    { id, name: "App", root_path: "/projects/app", git_default_branch: "main" },
  ]);
  ui.target = { repoId: id, location: "local" };
  expect(render()).toContain(`data-selected-repository="${id}"`);
});

it("normalizes a cloud SSH shortcut to the repository list identity", () => {
  client.setQueryData(queryKeys.settings.environments.repositories("account", "org"), {
    repos: ["acme/app"],
  });
  ui.target = { repoId: "git@github.com:Acme/App.git", location: "cloud" };
  expect(render()).toContain('data-selected-repository="https://github.com/acme/app"');
});

it("waits for accessible GitHub repositories before showing the empty state", () => {
  const html = render();
  expect(html).toContain("Loading repositories…");
  expect(html).not.toContain("Connect GitHub or add a local project to get started.");
});

it("shows the empty state after every repository source has loaded", () => {
  client.setQueryData(queryKeys.settings.environments.repositories("account", "org"), {
    repos: [],
  });
  expect(render()).toContain("Connect GitHub or add a local project to get started.");
});
