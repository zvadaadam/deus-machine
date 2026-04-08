export type CloneConflictKind = "already_cloned" | "non_git_target" | "other";

export function classifyCloneConflict(message: string): CloneConflictKind {
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes("already exists and is not a git repository") ||
    normalizedMessage.includes("path is not a git repository")
  ) {
    return "non_git_target";
  }

  if (
    normalizedMessage.includes("already contains a git repository") ||
    normalizedMessage.includes("destination path") ||
    normalizedMessage.includes("repository already exists")
  ) {
    return "already_cloned";
  }

  return "other";
}
