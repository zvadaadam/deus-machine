/**
 * Adding a project follows the place. On this computer a project is a folder:
 * start a new one, clone one from GitHub, or open one already here. In the
 * cloud it is a GitHub repository, added without a clone. The sidebar's "Add
 * project", the command palette and Home follow the window's place; the
 * composer's project picker follows the composer.
 */
import { match } from "ts-pattern";
import { projectRunsIn, type WorkspaceLocation } from "@/features/sidebar/lib/location";
import { parseGithubRepository, projectForRepository } from "@shared/git-origin";

export type AddProjectAction = "start-new" | "clone" | "open-local" | "add-from-github";

/** The ways to add a project in a place, in the order they are offered. */
export function addProjectActions(
  location: WorkspaceLocation,
  { nativeFolderPicker }: { nativeFolderPicker: boolean }
): AddProjectAction[] {
  return match(location)
    .with("local", (): AddProjectAction[] =>
      nativeFolderPicker ? ["start-new", "clone", "open-local"] : ["start-new", "clone"]
    )
    .with("cloud", (): AddProjectAction[] => ["add-from-github"])
    .exhaustive();
}

/** The command palette's entry for each way. */
export const ADD_PROJECT_COMMANDS: Record<AddProjectAction, string> = {
  "start-new": "start-new-project",
  clone: "clone-repository",
  "open-local": "open-project",
  "add-from-github": "add-from-github",
};

/** The palette's add entries that are not offered in a place. */
export function hiddenAddProjectCommands(
  location: WorkspaceLocation,
  options: { nativeFolderPicker: boolean }
): string[] {
  const offered = new Set(addProjectActions(location, options));
  return (Object.keys(ADD_PROJECT_COMMANDS) as AddProjectAction[])
    .filter((action) => !offered.has(action))
    .map((action) => ADD_PROJECT_COMMANDS[action]);
}

/**
 * What the add dialog shows for the organization's repositories: still asking,
 * a failure (with retry), none reachable (connect GitHub), or the list.
 */
export type CloudRepositoriesView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "list"; repositories: { slug: string; repoId: string | null }[] };

export function cloudRepositoriesView(
  query: {
    isPending: boolean;
    error: unknown;
    data?: { repositories: { slug: string; repoId: string | null }[] };
  },
  filter: string
): CloudRepositoriesView {
  if (query.data) {
    if (query.data.repositories.length === 0) return { kind: "empty" };
    const needle = filter.trim().toLowerCase();
    const repositories = needle
      ? query.data.repositories.filter((repo) => repo.slug.toLowerCase().includes(needle))
      : query.data.repositories;
    return { kind: "list", repositories };
  }
  if (query.error) {
    const message =
      query.error instanceof Error && query.error.message
        ? query.error.message
        : "Couldn't load the repositories.";
    return { kind: "error", message };
  }
  return { kind: "loading" };
}

/**
 * What the add dialog's public-repository field holds: nothing yet, something
 * that is not a GitHub repository (Add stays off), a repository to add, or one
 * that is already a project (the button opens it).
 */
export type PublicRepositoryInput =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "new"; slug: string }
  | { kind: "existing"; slug: string; repoId: string };

export function publicRepositoryInput(
  text: string,
  projects: readonly { repo_id: string; git_origin_url?: string | null }[]
): PublicRepositoryInput {
  if (!text.trim()) return { kind: "empty" };
  const slug = parseGithubRepository(text);
  if (!slug) return { kind: "invalid" };
  const project = projectForRepository(slug, projects);
  return project ? { kind: "existing", slug, repoId: project.repo_id } : { kind: "new", slug };
}

/**
 * The composer's projects: those that can run where its Cloud switch points,
 * by the sidebar's rule (`projectRunsIn`: this computer, a project with a
 * folder; the cloud, a project on GitHub). A project chosen deliberately stays
 * listed and selected wherever the switch points (one with no folder locks the
 * switch on); otherwise the preselection is the project already shown, else the
 * last project used, if it can run there, else the first that can, else none (the
 * composer's zero state).
 */
export function composerProjects<
  T extends { id: string; root_path: string | null; git_origin_url?: string | null },
>(
  repos: readonly T[],
  location: WorkspaceLocation,
  {
    chosen,
    shown = null,
    stored,
  }: {
    chosen: string | null;
    /** The project the composer shows now: kept while it can run there, so a switch
     *  that flips while access is checked does not change the project under it. */
    shown?: string | null;
    stored: string | null;
  }
): { listed: T[]; selectedId: string | null } {
  const runnable = repos.filter((repo) =>
    projectRunsIn(
      { has_folder: repo.root_path !== null, git_origin_url: repo.git_origin_url },
      location
    )
  );
  const picked = chosen ? repos.find((repo) => repo.id === chosen) : undefined;
  if (picked) {
    return {
      listed: runnable.includes(picked) ? runnable : [picked, ...runnable],
      selectedId: picked.id,
    };
  }
  const runs = (id: string | null): id is string => !!id && runnable.some((repo) => repo.id === id);
  const selectedId = (runs(shown) ? shown : runs(stored) ? stored : runnable[0]?.id) ?? null;
  return { listed: runnable, selectedId };
}
