import { execFileSync } from "child_process";
import { getDatabase } from "../lib/database";

export type WorkspaceTitleSource =
  | "legacy"
  | "manual"
  | "pr"
  | "branch"
  | "first_prompt"
  | "agent_summary"
  | "slug";

type WorkspaceTitleState = {
  id: string;
  slug: string;
  title: string | null;
  git_branch: string | null;
  title_source?: string | null;
};

const PROMOTABLE_TO_BRANCH = new Set<WorkspaceTitleSource>(["slug", "first_prompt", "branch"]);
const PROMOTABLE_TO_PR = new Set<WorkspaceTitleSource>([
  "slug",
  "first_prompt",
  "branch",
  "agent_summary",
  "pr",
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripLeadingNoise(value: string): string {
  return value.replace(/^[-*#>\d.)\s]+/, "").trim();
}

function ensureSentenceCasing(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}

export function deriveWorkspaceTitleFromUserMessage(content: string): string | null {
  const normalized = stripLeadingNoise(normalizeWhitespace(content));
  if (!normalized) return null;

  const firstLine = normalized.split(/\r?\n/, 1)[0] ?? normalized;
  const firstSentence =
    firstLine.match(/^(.+?)(?:[.!?](?:\s|$))/)?.[1] ??
    firstLine.match(/^(.{1,96})\b/u)?.[1] ??
    firstLine;
  const cleaned = firstSentence.replace(/[.!?]+$/g, "").trim();
  if (!cleaned) return null;
  return ensureSentenceCasing(cleaned).slice(0, 96).trim();
}

export function isPlaceholderWorkspaceBranch(branch: string | null, slug: string): boolean {
  if (!branch) return true;
  const normalized = branch.trim();
  if (!normalized) return true;
  const leaf = normalized.split("/").pop() ?? normalized;
  return leaf === slug;
}

export function getCurrentBranch(workspacePath: string): string | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 3000,
    })
      .toString()
      .trim();
    if (!branch || branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}

function normalizeTitleSource(source: string | null | undefined): WorkspaceTitleSource {
  switch (source) {
    case "manual":
    case "pr":
    case "branch":
    case "first_prompt":
    case "agent_summary":
    case "slug":
      return source;
    default:
      return "legacy";
  }
}

export function seedWorkspaceTitleFromFirstPrompt(
  workspaceId: string,
  existingTitle: string | null,
  existingSource: string | null | undefined,
  prompt: string
): boolean {
  const title = deriveWorkspaceTitleFromUserMessage(prompt);
  if (!title) return false;

  const source = normalizeTitleSource(existingSource);
  if (existingTitle && source !== "slug" && source !== "first_prompt") {
    return false;
  }

  const db = getDatabase();
  db.prepare("UPDATE workspaces SET title = ?, title_source = ? WHERE id = ?").run(
    title,
    "first_prompt",
    workspaceId
  );
  return true;
}

export function syncWorkspaceBranchAndTitle(
  workspace: WorkspaceTitleState,
  workspacePath: string
): boolean {
  const branch = getCurrentBranch(workspacePath);
  if (!branch || branch === workspace.git_branch) return false;

  const source = normalizeTitleSource(workspace.title_source);
  const canPromoteTitle =
    !isPlaceholderWorkspaceBranch(branch, workspace.slug) && PROMOTABLE_TO_BRANCH.has(source);
  const nextTitle = canPromoteTitle ? branch : workspace.title;
  const nextSource = canPromoteTitle ? "branch" : source;

  const db = getDatabase();
  db.prepare("UPDATE workspaces SET git_branch = ?, title = ?, title_source = ? WHERE id = ?").run(
    branch,
    nextTitle,
    nextSource,
    workspace.id
  );
  return true;
}

export function promoteWorkspaceTitleFromPr(
  workspace: Pick<WorkspaceTitleState, "id" | "title" | "title_source">,
  prTitle: string | null | undefined
): boolean {
  const normalizedTitle = prTitle?.trim();
  if (!normalizedTitle) return false;

  const source = normalizeTitleSource(workspace.title_source);
  if (!PROMOTABLE_TO_PR.has(source)) return false;
  if (workspace.title === normalizedTitle && source === "pr") return false;

  const db = getDatabase();
  db.prepare("UPDATE workspaces SET title = ?, title_source = ? WHERE id = ?").run(
    normalizedTitle,
    "pr",
    workspace.id
  );
  return true;
}

export function promoteWorkspaceTitleFromAgentSummary(
  workspaceId: string,
  existingTitle: string | null,
  existingSource: string | null | undefined,
  summaryTitle: string
): boolean {
  const normalizedTitle = summaryTitle.trim();
  if (!normalizedTitle) return false;

  const source = normalizeTitleSource(existingSource);
  if (
    existingTitle &&
    source !== "slug" &&
    source !== "first_prompt" &&
    source !== "agent_summary"
  ) {
    return false;
  }

  const db = getDatabase();
  db.prepare("UPDATE workspaces SET title = ?, title_source = ? WHERE id = ?").run(
    normalizedTitle,
    "agent_summary",
    workspaceId
  );
  return true;
}
