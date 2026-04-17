import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RefEntry } from "../../engine/types.js";
import type { RefEntryData, SessionData, SessionDefaults } from "./types.js";

const SESSION_DIR = join(homedir(), ".device-use", "sessions");

export class SessionStore {
  private filePath: string;
  private data: SessionData;

  constructor(sessionName: string = "default") {
    this.filePath = join(SESSION_DIR, `${sessionName}.json`);
    this.data = this.load();
  }

  getDefaults(): SessionDefaults {
    return { ...this.data.defaults };
  }

  setDefaults(partial: Partial<SessionDefaults>): void {
    this.data.defaults = { ...this.data.defaults, ...partial };
    this.save();
  }

  clearDefaults(keys?: (keyof SessionDefaults)[]): void {
    if (keys) {
      for (const key of keys) {
        delete this.data.defaults[key];
      }
    } else {
      this.data.defaults = {};
    }
    this.save();
  }

  getSimulatorUdid(overrideUdid?: string): string | undefined {
    return overrideUdid ?? this.data.defaults.simulatorUdid;
  }

  // --- Ref system ---

  getRefCounter(): number {
    return this.data.refCounter;
  }

  setRefs(refs: RefEntry[], nextCounter: number): void {
    this.data.refs = Object.fromEntries(refs.map(({ ref, ...data }) => [ref, data]));
    this.data.refCounter = nextCounter;
    this.save();
  }

  resolveRef(ref: string): RefEntryData | undefined {
    return this.data.refs[ref];
  }

  /** Full dump of the current ref map: keyed by @ref, value is ref data without the ref field. */
  resolveRefsDump(): Record<string, RefEntryData> {
    return { ...this.data.refs };
  }

  /** All refs as full RefEntry objects (ref key re-attached). */
  getAllRefs(): RefEntry[] {
    return Object.entries(this.data.refs).map(([ref, data]) => ({ ref, ...data }));
  }

  clearRefs(): void {
    this.data.refs = {};
    this.data.refCounter = 0;
    this.data.previousSnapshot = undefined;
    this.save();
  }

  // --- Snapshot diff ---

  getPreviousSnapshot(): RefEntryData[] | undefined {
    return this.data.previousSnapshot;
  }

  setPreviousSnapshot(entries: RefEntryData[]): void {
    this.data.previousSnapshot = entries;
    this.save();
  }

  // --- Persistence ---

  private load(): SessionData {
    if (existsSync(this.filePath)) {
      try {
        return JSON.parse(readFileSync(this.filePath, "utf-8")) as SessionData;
      } catch {
        // corrupted — start fresh
      }
    }
    return { defaults: {}, refCounter: 0, refs: {} };
  }

  private save(): void {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
