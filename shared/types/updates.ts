/** Electron owns update checks, downloads, and the staged installer. */
export type UpdateState =
  | { stage: "unsupported"; reason: string }
  | { stage: "idle" | "checking" }
  | { stage: "downloading"; version: string; percent?: number }
  | { stage: "ready"; version: string; releaseNotes?: string }
  | { stage: "error"; error: string; version?: string };

export type UpdateCheckResult =
  | { supported: false; available: false; reason: string }
  | { supported: true; available: boolean };
