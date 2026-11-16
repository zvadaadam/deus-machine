/**
 * Projects that are not on this computer: adding one follows the place, the
 * add dialog's states, and the composer's Cloud switch locked on.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  addProjectActions,
  cloudRepositoriesView,
  composerProjects,
  hiddenAddProjectCommands,
  publicRepositoryInput,
} from "@/features/repository/lib/addProject";
import {
  cloudControlWords,
  cloudOnlyReason,
  cloudOnlySendBlock,
} from "@/features/repository/lib/cloudControl";

vi.mock("@/shared/hooks/useDeusCloudSignIn", () => ({
  useDeusCloudSignIn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({ data: undefined }),
}));
vi.mock("@/platform/native/deus-cloud", () => ({ retryProvision: vi.fn() }));
vi.mock("@/features/sidebar/store/sidebarStore", () => ({
  retryCloudSetup: vi.fn(),
  useSidebarStore: (select: (s: { cloudSetupRetrying: boolean }) => unknown) =>
    select({ cloudSetupRetrying: false }),
}));
vi.mock("@/features/repository/ui/composer/useCloudRepoAccess", () => ({
  useCloudRepoAccess: () => ({ isError: false, data: { status: "ok", slug: "acme/rocket" } }),
}));
vi.mock("@/features/repository/ui/composer/GrantRepositoryAccessModal", () => ({
  GrantRepositoryAccessModal: () => null,
}));
vi.mock("@/features/workspace/ui/BranchSelector", () => ({ BranchSelector: () => null }));

const { CloudToggle } = await import("@/features/repository/ui/composer/ComposerControls");
const { TooltipProvider } = await import("@/components/ui/tooltip");

describe("adding a project follows the place", () => {
  it("is the three local actions on this computer, unchanged", () => {
    expect(addProjectActions("local", { nativeFolderPicker: true })).toEqual([
      "start-new",
      "clone",
      "open-local",
    ]);
    // Without a folder picker (a browser, a phone) there is nothing to open.
    expect(addProjectActions("local", { nativeFolderPicker: false })).toEqual([
      "start-new",
      "clone",
    ]);
  });

  it("is Add from GitHub alone in the cloud", () => {
    for (const nativeFolderPicker of [true, false]) {
      expect(addProjectActions("cloud", { nativeFolderPicker })).toEqual(["add-from-github"]);
    }
  });

  it("hides the other place's entries in the command palette", () => {
    expect(hiddenAddProjectCommands("local", { nativeFolderPicker: true })).toEqual([
      "add-from-github",
    ]);
    expect(hiddenAddProjectCommands("cloud", { nativeFolderPicker: true }).sort()).toEqual([
      "clone-repository",
      "open-project",
      "start-new-project",
    ]);
  });
});

describe("the add dialog's states", () => {
  const list = {
    repositories: [
      { slug: "acme/rocket", repoId: "r1" },
      { slug: "acme/Docs", repoId: null },
      { slug: "beta/tools", repoId: null },
    ],
  };

  it("is loading until an answer arrives", () => {
    expect(cloudRepositoriesView({ isPending: true, error: null }, "")).toEqual({
      kind: "loading",
    });
  });

  it("says why it failed, so it can be retried", () => {
    expect(
      cloudRepositoriesView({ isPending: false, error: new Error("Sign in to Deus Cloud") }, "")
    ).toEqual({ kind: "error", message: "Sign in to Deus Cloud" });
    expect(cloudRepositoriesView({ isPending: false, error: "x" }, "")).toEqual({
      kind: "error",
      message: "Couldn't load the repositories.",
    });
  });

  it("is empty when GitHub reaches none (connect GitHub)", () => {
    expect(
      cloudRepositoriesView({ isPending: false, error: null, data: { repositories: [] } }, "a")
    ).toEqual({ kind: "empty" });
  });

  it("lists them, filtered by the search, and keeps which are projects", () => {
    expect(cloudRepositoriesView({ isPending: false, error: null, data: list }, "")).toEqual({
      kind: "list",
      repositories: list.repositories,
    });
    expect(cloudRepositoriesView({ isPending: false, error: null, data: list }, " DOC ")).toEqual({
      kind: "list",
      repositories: [{ slug: "acme/Docs", repoId: null }],
    });
    // A refetch's error does not hide a list already read.
    expect(
      cloudRepositoriesView({ isPending: false, error: new Error("blip"), data: list }, "beta")
    ).toEqual({ kind: "list", repositories: [{ slug: "beta/tools", repoId: null }] });
  });
});

describe("the add dialog's public repository field", () => {
  const projects = [
    { repo_id: "r-az", git_origin_url: "git@github.com:acme/skills.git" },
    { repo_id: "r-local", git_origin_url: null },
  ];

  it("takes only what names a GitHub repository", () => {
    expect(publicRepositoryInput("  ", projects)).toEqual({ kind: "empty" });
    expect(publicRepositoryInput("not a repo", projects)).toEqual({ kind: "invalid" });
    expect(publicRepositoryInput("https://gitlab.com/a/b", projects)).toEqual({ kind: "invalid" });
    expect(publicRepositoryInput("vercel/next.js", projects)).toEqual({
      kind: "new",
      slug: "vercel/next.js",
    });
    expect(publicRepositoryInput("git@github.com:vercel/swr.git", projects)).toEqual({
      kind: "new",
      slug: "vercel/swr",
    });
  });

  it("recognises a repository that is already a project, however it is written", () => {
    for (const text of [
      "acme/skills",
      "https://github.com/Acme/skills",
      "https://github.com/acme/skills.git",
    ]) {
      expect(publicRepositoryInput(text, projects)).toMatchObject({
        kind: "existing",
        repoId: "r-az",
      });
    }
  });
});

describe("the composer's projects follow where it points", () => {
  const local = { id: "sample", root_path: "/Users/me/sample", git_origin_url: null };
  const both = {
    id: "rocket",
    root_path: "/Users/me/rocket",
    git_origin_url: "https://github.com/acme/rocket",
  };
  const cloudOnly = {
    id: "az",
    root_path: null,
    git_origin_url: "https://github.com/acme/skills",
  };
  const repos = [local, both, cloudOnly];
  const none = { chosen: null, stored: null };

  it("lists in the cloud only projects on GitHub, and never preselects one without a remote", () => {
    const cloud = composerProjects(repos, "cloud", { chosen: null, stored: "sample" });
    expect(cloud.listed.map((repo) => repo.id)).toEqual(["rocket", "az"]);
    expect(cloud.selectedId).toBe("rocket");
  });

  it("lists on this computer only projects with a folder", () => {
    const here = composerProjects(repos, "local", none);
    expect(here.listed.map((repo) => repo.id)).toEqual(["sample", "rocket"]);
    expect(here.selectedId).toBe("sample");
    expect(composerProjects(repos, "local", { chosen: null, stored: "rocket" }).selectedId).toBe(
      "rocket"
    );
  });

  it("keeps the project it shows while that can run there (the switch flipping during the access check)", () => {
    // In the cloud it showed rocket; the access check turns the switch off a moment.
    expect(
      composerProjects(repos, "local", { chosen: null, shown: "rocket", stored: null }).selectedId
    ).toBe("rocket");
    // What it showed on this computer cannot run in the cloud: the first that can.
    expect(
      composerProjects(repos, "cloud", { chosen: null, shown: "sample", stored: null }).selectedId
    ).toBe("rocket");
  });

  it("selects nothing where nothing can run (the composer's zero state)", () => {
    expect(composerProjects([local], "cloud", none)).toEqual({ listed: [], selectedId: null });
  });

  it("keeps a project chosen deliberately, wherever the switch points", () => {
    const chosen = composerProjects(repos, "local", { chosen: "az", stored: null });
    expect(chosen.selectedId).toBe("az");
    expect(chosen.listed.map((repo) => repo.id)).toEqual(["az", "sample", "rocket"]);
  });
});

describe("the composer with a project that is not on this computer", () => {
  const cloudy = { name: "rocket", root_path: null };
  const local = { name: "deus", root_path: "/Users/me/deus" };

  it("can only run in the cloud, and says why", () => {
    expect(cloudOnlyReason(cloudy)).toBe("rocket is not on this Mac");
    expect(cloudOnlyReason(local)).toBeNull();
    expect(cloudOnlyReason(null)).toBeNull();
    expect(
      cloudControlWords({
        several: false,
        location: "cloud",
        organizationName: null,
        lockedReason: "rocket is not on this Mac",
      }).tooltip
    ).toBe("rocket is not on this Mac");
  });

  it("blocks the send in words when the cloud cannot be used", () => {
    expect(cloudOnlySendBlock({ repo: cloudy, cloudReady: true, organizationName: "Acme" })).toBe(
      null
    );
    expect(
      cloudOnlySendBlock({ repo: cloudy, cloudReady: false, organizationName: "Acme" })
    ).toMatch(/Acme is not set up on this computer/);
    expect(cloudOnlySendBlock({ repo: cloudy, cloudReady: false, organizationName: null })).toMatch(
      /Sign in to Deus Cloud/
    );
    expect(
      cloudOnlySendBlock({ repo: cloudy, cloudReady: undefined, organizationName: null })
    ).not.toBeNull();
    // A project on this computer is never blocked by the cloud.
    expect(cloudOnlySendBlock({ repo: local, cloudReady: false, organizationName: null })).toBe(
      null
    );
  });

  const render = (lockedReason: string | null, location: "local" | "cloud") =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(CloudToggle, {
          location,
          onLocationChange: vi.fn(),
          organization: null,
          repoId: "repo",
          cloudReady: true,
          lockedReason,
        })
      )
    );

  it("shows the Cloud switch on and disabled, with its reason as the tooltip's trigger", () => {
    const html = render("rocket is not on this Mac", "cloud");
    const toggle = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(toggle).toContain('aria-checked="true"');
    expect(toggle).toMatch(/disabled=""/);
    // The tooltip is attached even where the composer would not explain the switch.
    expect(html).toContain('data-slot="tooltip-trigger"');
  });

  it("leaves the switch free for a project on this computer", () => {
    const html = render(null, "local");
    const toggle = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(toggle).toContain('aria-checked="false"');
    expect(toggle).not.toMatch(/disabled=""/);
  });
});
