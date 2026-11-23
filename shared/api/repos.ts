/**
 * Repositories: the projects this computer knows, their branches, pull
 * requests and environment file. A project has a folder on this computer, or
 * none: then it is a GitHub repository that runs only in the cloud.
 */

import { ProjectEnvironmentSchema, type ProjectEnvironment } from "@deus-hq/api";
import { z } from "zod";
import type { CloudRepoAccess } from "../types/cloud-access";
import type { BranchSummary, GithubAppState, PRSummary } from "../types/github";
import type { RecentProject } from "../types/onboarding";
import type { InspectedRepository, Repository } from "../types/repository";
import { live, out, read, write } from "./op";
import { stream } from "./stream";

const repoId = z.object({ repoId: z.string().min(1) });
const rootPath = z.object({ root_path: z.string().min(1) });
const HTTPS_URL = /^https:\/\/[^\s;|&`$()]+$/;
const organization = z.object({ organizationId: z.string().min(1).nullish() });

/** Every project added to this computer, with a folder here or not. */
export const repos = live({ name: "repos", output: out<Repository[]>() });

/** The project's `.deus/environment.json` in its local checkout, and the branch checked out there. */
export const repoEnvironmentFile = read({
  name: "repoEnvironmentFile",
  input: repoId,
  output: out<{ project: ProjectEnvironment | null; branch: string }>(),
});

/** Open pull requests on GitHub, to start a workspace from one. Empty when GitHub cannot answer. */
export const repoPrs = read({ name: "repoPrs", input: repoId, output: out<PRSummary[]>() });

/**
 * Branches on origin. A project with a folder here: what git last fetched,
 * most recently committed first (the first hundred). A project with no folder:
 * GitHub's, the default branch first (the first three hundred), read with
 * `organizationId`'s GitHub access (the default organization when omitted).
 */
export const repoBranches = read({
  name: "repoBranches",
  input: repoId.extend({ organizationId: z.string().min(1).nullish() }),
  output: out<{ branches: BranchSummary[] }>(),
});

/**
 * The repositories a cloud organization's GitHub App can reach (the default
 * organization when omitted), each with the project that already exists for
 * it here (`repoId`), if any.
 */
export const cloudRepositories = read({
  name: "cloudRepositories",
  input: organization,
  output: out<{ repositories: { slug: string; repoId: string | null }[] }>(),
});

/** A cloud organization's Deus GitHub App (the default organization when omitted). */
export const githubApp = read({
  name: "githubApp",
  input: organization,
  output: out<GithubAppState>(),
});

/** The github.com page that installs the organization's GitHub App, signed by Deus Cloud. */
export const githubAppInstallUrl = read({
  name: "githubAppInstallUrl",
  input: organization,
  output: out<{ url: string }>(),
});

/**
 * Add a GitHub repository as a project with no folder on this computer (it runs
 * in the cloud; nothing is cloned). `repository` is `owner/name` or a github.com
 * address (https or ssh). A repository that is already a project returns that
 * project.
 */
export const addCloudRepo = write({
  name: "addCloudRepo",
  input: z.object({
    repository: z.string().trim().min(1),
    organizationId: z.string().min(1).nullish(),
  }),
  output: out<Repository>(),
});

/** Whether a cloud sandbox could clone this project right now. */
export const cloudRepoAccess = read({
  name: "cloudRepoAccess",
  /** `organizationId`: the organization the workspace would run in; the default when omitted.
   *  `fresh`: ask GitHub's App again instead of reusing a recent answer (the gate awaiting a grant). */
  input: repoId.extend({
    organizationId: z.string().min(1).optional(),
    fresh: z.boolean().optional(),
  }),
  output: out<CloudRepoAccess>(),
});

/** Projects recently opened in Cursor, VS Code or Claude on this computer. */
export const recentProjects = read({
  name: "recentProjects",
  output: out<{ projects: RecentProject[] }>(),
});

/** Look at a folder as a git repository without adding it. */
export const inspectRepo = read({
  name: "inspectRepo",
  input: rootPath,
  output: out<InspectedRepository>(),
});

/**
 * Add a folder on this computer as a project. One that was already added is
 * refused with 409 and the existing project as `details`. A folder whose
 * origin is a project with no folder here becomes that project's folder.
 */
export const addRepo = write({ name: "addRepo", input: rootPath, output: out<Repository>() });

const removalConfirmation = z.object({
  rootPath: z.string().nullable(),
  counts: z.object({
    archivedWorkspaces: z.int().nonnegative(),
    chats: z.int().nonnegative(),
    automations: z.int().nonnegative(),
  }),
});
export type RepoRemovalConfirmation = z.infer<typeof removalConfirmation>;

/** What the confirmation shows, or the reason this project must stay. */
export const repoRemoval = read({
  name: "repoRemoval",
  input: repoId,
  output: out<RepoRemovalConfirmation>(),
});

export const removeRepo = write({
  name: "removeRepo",
  input: repoId.extend({ confirmed: removalConfirmation }),
  output: out<void>(),
});

/** Write the project's `.deus/environment.json` in its local checkout. */
export const saveRepoEnvironmentFile = write({
  name: "saveRepoEnvironmentFile",
  input: repoId.extend({ project: ProjectEnvironmentSchema }),
  output: out<void>(),
});

/**
 * Clone a repository into a folder under the home directory. Progress arrives
 * as `git-clone-progress` events.
 */
export const gitClone = write({
  name: "gitClone",
  input: z.object({ url: z.string().min(1), targetPath: z.string().min(1) }),
  /** Where the repository now is, with `~` expanded. */
  output: out<{ path: string }>(),
});

/**
 * Create a new project folder with a first commit and, when GitHub is signed
 * in, a private repository for it. Progress arrives as `git-init-progress` events.
 */
export const gitInit = write({
  name: "gitInit",
  input: z
    .object({
      projectName: z
        .string()
        .min(1)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Invalid project name"),
      targetPath: z.string().min(1),
      /** Start empty (the default) or from a copy of the repository at `templateUrl`. */
      templateType: z.enum(["empty", "github"]).optional(),
      templateUrl: z.string().optional(),
    })
    .refine((input) => input.templateType !== "github" || HTTPS_URL.test(input.templateUrl ?? ""), {
      path: ["templateUrl"],
      message: "Only HTTPS URLs are allowed",
    }),
  /** `githubUrl` is null when no GitHub repository was created. */
  output: out<{ path: string; githubUrl: string | null }>(),
});

/** Git's own progress lines while a repository is cloned or a new project is created. */
export const gitProgress = stream({
  name: "gitProgress",
  scope: z.object({ operation: z.enum(["clone", "init"]) }),
  event: out<{ line: string }>(),
});
