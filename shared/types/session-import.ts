// shared/types/session-import.ts
// DTOs for the `importable_sessions` WS resource and `importExternalSession`
// command — sessions discovered in other coding agents' local storage
// (Claude Code / Codex / Cursor) that can be imported into deus.db.

export type ImportProvider = "claude-code" | "codex" | "cursor";

export type ImportProjectMatch =
  | { kind: "workspace"; repositoryId: string; workspaceId: string; projectName: string }
  | { kind: "repository"; repositoryId: string; projectName: string }
  | { kind: "unknown"; projectName: string };

export interface ImportableSessionDTO {
  /** Stable identity key — pass to importExternalSession as `key`. */
  key: string;
  provider: ImportProvider;
  title: string;
  cwd: string;
  lastTimestamp?: string;
  messageCount: number;
  sizeBytes: number;
  model?: string;
  imported: boolean;
  importedSessionId?: string;
  project: ImportProjectMatch;
}

export interface ImportableGroup {
  projectName: string;
  kind: ImportProjectMatch["kind"];
  repositoryId?: string;
  /** Default import target: matched workspace, else the repo's most recent workspace. */
  defaultWorkspaceId?: string;
  sessions: ImportableSessionDTO[];
}

export interface ImportableSessionsSnapshot {
  status: "scanning" | "ready" | "error";
  scannedAt?: string;
  /** Wall-clock duration of the last completed scan. */
  scanMs?: number;
  groups: ImportableGroup[];
  totals: Record<ImportProvider, number>;
  error?: string;
}
