import { expect, it } from "vitest";
import { environmentRepositories } from "@/features/settings/lib/environment-repositories";
import type { Repository } from "@shared/types/repository";

it("joins GitHub, SSH local clones and saved setup without hiding either local checkout", () => {
  const locals: Repository[] = ["one", "two"].map((id) => ({
    id,
    name: "app",
    root_path: `/projects/${id}`,
    git_default_branch: "main",
    git_origin_url: "git@github.com:Acme/App.git",
  }));
  const environment = {
    id: "environment",
    name: "recipe",
    repo: "https://github.com/acme/app",
    ownerType: "ORG" as const,
    isRepositoryDefault: true,
  };
  const rows = environmentRepositories(locals, ["acme/app"], [environment]);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.local?.id).sort()).toEqual(["one", "two"]);
  expect(rows.every((row) => row.environment?.id === environment.id)).toBe(true);
});
it("keeps personal recipes selectable beside shared setup for the same repository", () => {
  const rows = environmentRepositories(
    [],
    [],
    [
      {
        id: "personal",
        name: "mine",
        repo: "https://github.com/acme/app",
        ownerType: "USER",
        isRepositoryDefault: false,
      },
      {
        id: "shared",
        name: "shared",
        repo: "https://github.com/acme/app",
        ownerType: "ORG",
        isRepositoryDefault: true,
      },
    ]
  );
  expect(rows.map((row) => row.environment?.id).sort()).toEqual(["personal", "shared"]);
});

it("matches provisioning identity without collapsing a .git/ origin into a different recipe", () => {
  const rows = environmentRepositories(
    [
      {
        id: "local",
        name: "app",
        root_path: "/app",
        git_default_branch: "main",
        git_origin_url: "https://github.com/acme/app.git/",
      },
    ],
    [],
    [
      {
        id: "saved",
        name: "recipe",
        repo: "https://github.com/acme/app",
        ownerType: "ORG",
        isRepositoryDefault: true,
      },
    ]
  );
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.local)?.environment).toBeUndefined();
});

it("does not label a repository configured when only an alternate recipe exists", () => {
  const rows = environmentRepositories(
    [],
    ["acme/app"],
    [
      {
        id: "alternate",
        name: "custom-template",
        repo: "https://github.com/acme/app",
        ownerType: "ORG",
        isRepositoryDefault: false,
      },
    ]
  );
  expect(rows).toHaveLength(2);
  expect(
    rows.find((row) => row.key === "https://github.com/acme/app")?.environment
  ).toBeUndefined();
  expect(rows.find((row) => row.key === "alternate")?.environment?.id).toBe("alternate");
});
