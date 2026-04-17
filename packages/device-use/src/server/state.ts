// Persistent per-workspace state — single JSON file at
// {storageDir}/state.json. Read on server start, written on mutations.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PersistedState {
  version: 1;
  simulator?: { udid: string };
  project?: { path: string; scheme?: string; configuration?: string };
  updatedAt: number;
}

const DEFAULT: PersistedState = {
  version: 1,
  updatedAt: 0,
};

export class StateStore {
  private state: PersistedState = { ...DEFAULT };
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly storageDir: string) {
    this.file = path.join(storageDir, "state.json");
  }

  async load(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version === 1) {
        this.state = { ...DEFAULT, ...parsed };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[state] failed to read ${this.file}: ${(err as Error).message}`);
      }
      // Missing file is expected on first run.
    }
    return this.state;
  }

  get(): PersistedState {
    return this.state;
  }

  async update(
    patch: Partial<Omit<PersistedState, "version" | "updatedAt">>
  ): Promise<PersistedState> {
    this.state = {
      ...this.state,
      ...patch,
      version: 1,
      updatedAt: Date.now(),
    };
    await this.persist();
    return this.state;
  }

  async clear(): Promise<void> {
    this.state = { ...DEFAULT, updatedAt: Date.now() };
    await this.persist();
  }

  private async persist(): Promise<void> {
    // Chain writes so we never clobber a previous write.
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.storageDir, { recursive: true });
      await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
    });
    return this.writeChain;
  }
}

export function resolveStorageDir(env: NodeJS.ProcessEnv = process.env): string {
  // Preferred: explicit AAP-style env var.
  if (env.DEUS_STORAGE) return env.DEUS_STORAGE;
  // Fallback: .device-use inside the current working directory.
  return path.join(process.cwd(), ".device-use");
}
