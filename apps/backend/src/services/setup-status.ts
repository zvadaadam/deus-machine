import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SetupStatus } from "@shared/enums";

export const SETUP_INTERRUPTED = "Setup was stopped when Deus closed. Run it again.";
export const SETUP_LOG_SUFFIX = " View the setup log for details.";

export function setupFile(workspaceId: string, extension: "log" | "status"): string {
  return path.join(os.tmpdir(), `deus-${workspaceId}-setup.${extension}`);
}

export function writeSetupStatusFile(
  workspaceId: string,
  status: SetupStatus,
  code?: number | null
): void {
  const file = setupFile(workspaceId, "status");
  const temporary = `${file}.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, code == null ? `${status}\n` : `${status} ${code}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } catch (error) {
    console.warn(`[WORKSPACE] Could not write setup status to ${file}:`, error);
    for (const stale of [file, temporary]) {
      try {
        fs.rmSync(stale, { force: true });
      } catch {
        // The temp directory itself may be unwritable.
      }
    }
  }
}
