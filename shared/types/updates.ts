/** Electron owns update checks, downloads, and the staged installer. */
export type UpdateState =
  | { stage: "idle" | "checking" }
  | { stage: "downloading"; version: string; percent?: number }
  | { stage: "ready"; version: string; releaseNotes?: string }
  | { stage: "error"; error: string };

export type UpdateCheckResult =
  | { supported: false; available: false; reason: string }
  | { supported: true; available: boolean };
