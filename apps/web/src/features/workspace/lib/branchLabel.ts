import type { BranchSummary } from "@shared/types/github";

/**
 * How a branch reads in a branch list. A branch from a clone's remote-tracking
 * refs is `origin/<name>`; a project with no folder here has no clone, and its
 * branches (GitHub's) are plain names. Either way the name sent on is `name`.
 */
export function branchLabel(branch: BranchSummary): {
  prefix: "origin/" | null;
  localOnly: boolean;
} {
  const localOnly = branch.is_local === true && branch.is_remote !== true;
  return { prefix: branch.is_remote === true ? "origin/" : null, localOnly };
}
