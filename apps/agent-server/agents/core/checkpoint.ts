// agent-server/checkpoint.ts
// Creates git checkpoints at turn boundaries using direct git commands.
// These checkpoints allow Deus to offer undo/revert for each AI turn.
// Stored as private git refs under refs/deus-checkpoints/. The git commands
// run asynchronously: the engine shares the backend's process, whose event
// loop serves the app.

import { execFile } from "child_process";
import { getErrorMessage } from "@shared/lib/errors";

const CHECKPOINT_SKIP_PATTERNS = [
  "merge in progress",
  "rebase in progress",
  "unmerged",
  "error building trees",
  "resolve your current index first",
] as const;

/** How long one git command may take: a turn's hook waits for its checkpoint. */
const GIT_TIMEOUT_MS = 15_000;

/** One git command's trimmed output; its stderr is in the error's message. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf-8", timeout: GIT_TIMEOUT_MS }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).trim())
    );
  });
}

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
export async function createCheckpoint(
  sessionId: string,
  turnId: string,
  checkpointType: "start" | "end",
  cwd: string,
  logPrefix: string
): Promise<void> {
  const checkpointId = `session-${sessionId}-turn-${turnId}-${checkpointType}`;
  const refName = `refs/deus-checkpoints/${checkpointId}`;

  console.log(
    `${logPrefix} Creating ${checkpointType} checkpoint for sessionId: ${sessionId}, turnId: ${turnId}`
  );

  try {
    // Create a tree object from the current working directory state
    const headRef = await git(cwd, ["rev-parse", "HEAD"]);

    // Create a tree from the index (staged changes)
    const indexTree = await git(cwd, ["write-tree"]);

    // Create a checkpoint commit message with metadata
    const commitMessage = [
      `checkpoint:${checkpointId}`,
      `head ${headRef}`,
      `index-tree ${indexTree}`,
      `created ${new Date().toISOString()}`,
    ].join("\n");

    // Create the commit object (using arg array avoids shell injection)
    const commitHash = await git(cwd, [
      "commit-tree",
      indexTree,
      "-p",
      headRef,
      "-m",
      commitMessage,
    ]);

    // Store it as a ref
    await git(cwd, ["update-ref", refName, commitHash]);

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
