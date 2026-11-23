// A turn's checkpoint is a private commit of the index, parented to HEAD.
import { getErrorMessage } from "@shared/lib/errors";
import { GitError, runGit } from "@shared/lib/git-process";

export async function createCheckpoint(
  sessionId: string,
  turnId: string,
  checkpointType: "start" | "end",
  cwd: string,
  logPrefix: string
): Promise<void> {
  const checkpointId = `session-${sessionId}-turn-${turnId}-${checkpointType}`;
  const refName = `refs/deus-checkpoints/${checkpointId}`;
  const options = { cwd, timeoutMs: 15_000 };

  console.log(
    `${logPrefix} Creating ${checkpointType} checkpoint for sessionId: ${sessionId}, turnId: ${turnId}`
  );

  try {
    const headRef = (await runGit(["rev-parse", "HEAD"], options)).trim();
    const indexTree = (await runGit(["write-tree"], options)).trim();
    const message = [
      `checkpoint:${checkpointId}`,
      `head ${headRef}`,
      `index-tree ${indexTree}`,
      `created ${new Date().toISOString()}`,
    ].join("\n");
    const commit = (
      await runGit(["commit-tree", indexTree, "-p", headRef, "-m", message], options)
    ).trim();
    await runGit(["update-ref", refName, commit], options);
    console.log(`${logPrefix} Created ${checkpointType} checkpoint: ${commit.slice(0, 8)}`);
  } catch (error) {
    // A merge or rebase can be checkpointed once its index has no conflicts.
    if (error instanceof GitError && error.code !== null && error.args[0] === "write-tree") {
      const unmerged = await runGit(
        ["diff", "--cached", "--quiet", "--no-relative", "--diff-filter=U"],
        options
      ).then(
        () => false,
        (failure: unknown) => failure instanceof GitError && failure.code === 1
      );
      if (unmerged) {
        console.log(`${logPrefix} Checkpoint ${checkpointType} skipped: unmerged index`);
        return;
      }
    }
    console.error(`${logPrefix} Checkpoint ${checkpointType} failed:`, getErrorMessage(error));
  }
}
