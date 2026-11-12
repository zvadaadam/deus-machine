/** Repositories: the projects on this computer, their branches, pull requests and environment file. */

import { ProjectEnvironmentSchema, type ProjectEnvironment } from "@deus-hq/api";
import { z } from "zod";
import type { CloudRepoAccess } from "../types/cloud-access";
import type { BranchSummary, PRSummary } from "../types/github";
import type { RecentProject } from "../types/onboarding";
import type { InspectedRepository, Repository } from "../types/repository";
import { out, read, write } from "./op";
import { stream } from "./stream";

const repoId = z.object({ repoId: z.string().min(1) });
const rootPath = z.object({ root_path: z.string().min(1) });
const HTTPS_URL = /^https:\/\/[^\s;|&`$()]+$/;

/** Every project added to this computer. */
export const repos = read({ name: "repos", output: out<Repository[]>() });

/** The project's `.deus/environment.json` in its local checkout, and the branch checked out there. */
export const repoEnvironmentFile = read({
  name: "repoEnvironmentFile",
  input: repoId,
  output: out<{ project: ProjectEnvironment | null; branch: string }>(),
});

/** Open pull requests on GitHub, to start a workspace from one. Empty when GitHub cannot answer. */
export const repoPrs = read({ name: "repoPrs", input: repoId, output: out<PRSummary[]>() });

/** Branches on origin, most recently committed first (the first hundred). */
export const repoBranches = read({
  name: "repoBranches",
  input: repoId,
  output: out<{ branches: BranchSummary[] }>(),
});

/** Whether a cloud sandbox could clone this project right now. */
export const cloudRepoAccess = read({
  name: "cloudRepoAccess",
  input: repoId,
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
 * refused with 409 and the existing project as `details`.
 */
export const addRepo = write({ name: "addRepo", input: rootPath, output: out<Repository>() });

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
  name: "git:clone",
  input: z.object({ url: z.string().min(1), targetPath: z.string().min(1) }),
  /** Where the repository now is, with `~` expanded. */
  output: out<{ path: string }>(),
});

/**
 * Create a new project folder with a first commit and, when GitHub is signed
 * in, a private repository for it. Progress arrives as `git-init-progress` events.
 */
export const gitInit = write({
  name: "git:init",
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
