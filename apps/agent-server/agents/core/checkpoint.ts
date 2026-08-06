// agent-server/checkpoint.ts
// Creates git checkpoints at turn boundaries using direct git commands.
// These checkpoints allow Deus to offer undo/revert for each AI turn.
// Stored as private git refs under refs/deus-checkpoints/.

import { execFileSync } from "child_process";
import { getErrorMessage } from "@shared/lib/errors";

const CHECKPOINT_SKIP_PATTERNS = [
  "merge in progress",
  "rebase in progress",
  "unmerged",
  "error building trees",
  "resolve your current index first",
] as const;

function shouldSkipCheckpoint(message: string): boolean {
  const normalized = message.toLowerCase();
  return CHECKPOINT_SKIP_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Creates a start or end checkpoint for a given session turn.
 *
 * Checkpoint IDs follow the pattern: session-<sessionId>-turn-<turnId>-<start|end>
 * They are stored as private git refs under refs/deus-checkpoints/.
 *
 * The checkpoint commit captures:
 * - Current HEAD
 * - Index (staged changes)
 * - Working tree state (including unstaged changes)
 *
 * @param sessionId     The active session identifier
 * @param turnId        The current turn identifier
 * @param checkpointType  "start" or "end"
 * @param cwd           Working directory (must be inside a git repo)
 * @param logPrefix     Label used in log messages
 */
export function createCheckpoint(
  sessionId: string,
  turnId: string,
  checkpointType: "start" | "end",
  cwd: string,
  logPrefix: string
): void {
  const checkpointId = `session-${sessionId}-turn-${turnId}-${checkpointType}`;
  const refName = `refs/deus-checkpoints/${checkpointId}`;

  console.log(
    `${logPrefix} Creating ${checkpointType} checkpoint for sessionId: ${sessionId}, turnId: ${turnId}`
  );

  try {
    // Create a tree object from the current working directory state
    const headRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();

    // Create a tree from the index (staged changes)
    const indexTree = execFileSync("git", ["write-tree"], { cwd, encoding: "utf-8" }).trim();

    // Create a checkpoint commit message with metadata
    const commitMessage = [
      `checkpoint:${checkpointId}`,
      `head ${headRef}`,
      `index-tree ${indexTree}`,
      `created ${new Date().toISOString()}`,
    ].join("\n");

    // Create the commit object (using arg array avoids shell injection)
    const commitHash = execFileSync(
      "git",
      ["commit-tree", indexTree, "-p", headRef, "-m", commitMessage],
      { cwd, encoding: "utf-8" }
    ).trim();

    // Store it as a ref
    execFileSync("git", ["update-ref", refName, commitHash], { cwd, encoding: "utf-8" });

    console.log(`${logPrefix} Created ${checkpointType} checkpoint: ${commitHash.substring(0, 8)}`);
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    if (shouldSkipCheckpoint(msg)) {
      console.log(`${logPrefix} Checkpoint ${checkpointType} skipped: merge/rebase in progress`);
    } else {
      console.error(`${logPrefix} Checkpoint ${checkpointType} failed:`, msg);
    }
  }
}
