import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SetupStatus } from "@shared/enums";
import { getDatabase } from "../lib/database";
import { invalidate } from "./query-engine";

export const SETUP_INTERRUPTED = "Setup was stopped when Deus closed. Run it again.";
export const SETUP_LOG_SUFFIX = " View the setup log for details.";

export function setupFile(workspaceId: string, extension: "log" | "status"): string {
  return path.join(os.tmpdir(), `deus-${workspaceId}-setup.${extension}`);
}

/** The row is the app's status; the file lets a turn already running check it with cat. */
export function setSetupStatus(
  workspaceId: string,
  status: SetupStatus,
  failure?: { message: string; detail?: string | null; exitCode?: number | null }
): void {
  const db = getDatabase();
  db.transaction(() => {
    const update = db
      .prepare(
        "UPDATE workspaces SET setup_status = ?, error_message = ?, error_detail = ? WHERE id = ?"
      )
      .run(status, failure?.message ?? null, failure?.detail ?? null, workspaceId);
    if (!update.changes) return;
    const file = setupFile(workspaceId, "status");
    const temporary = `${file}.${randomUUID()}`;
    try {
      const code = failure?.exitCode;
      fs.writeFileSync(temporary, code == null ? `${status}\n` : `${status} ${code}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  })();
  invalidate(["workspaces"]);
}
