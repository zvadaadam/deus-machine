import type { RefEntry } from "../../engine/types.js";

export interface SessionDefaults {
  simulatorUdid?: string;
  simulatorName?: string;
  scheme?: string;
  workspacePath?: string;
  projectPath?: string;
  configuration?: string;
  bundleId?: string;
}

export interface SessionData {
  defaults: SessionDefaults;
  refCounter: number;
  refs: Record<string, RefEntryData>;
  previousSnapshot?: RefEntryData[];
}

export type RefEntryData = Omit<RefEntry, "ref">;
