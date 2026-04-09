export type CloneConflictKind = "already_cloned" | "non_git_target" | "other";

function parseGitHubRepo(url: string): string | null {
  const sshMatch = url.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = url.match(/https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

export function isMatchingGitHubRepo(
  originUrl: string | null | undefined,
  expectedUrl: string
): boolean {
  if (!originUrl) return false;

  const originRepo = parseGitHubRepo(originUrl);
  const expectedRepo = parseGitHubRepo(expectedUrl);
  return originRepo !== null && expectedRepo !== null && originRepo === expectedRepo;
}

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
    (normalizedMessage.includes("destination path") &&
      normalizedMessage.includes("already exists")) ||
    normalizedMessage.includes("repository already exists")
  ) {
    return "already_cloned";
  }

  return "other";
}
