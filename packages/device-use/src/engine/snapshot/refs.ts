import type { RefEntry } from "../types.js";

/**
 * Flat ref-key store. Holds `@e1..@eN` → RefEntry mappings.
 * Ref assignment itself lives in `build.ts` so the tree walker owns both
 * the counter increment and the ancestor/child decisions in one pass.
 */
export class RefMap {
  private readonly map = new Map<string, RefEntry>();
  private counter: number;

  constructor(startCounter: number = 0) {
    this.counter = startCounter;
  }

  /** Allocate the next `@eN` ref. */
  nextRef(): string {
    this.counter++;
    return `@e${this.counter}`;
  }

  set(entry: RefEntry): void {
    this.map.set(entry.ref, entry);
  }

  resolve(ref: string): RefEntry | undefined {
    return this.map.get(ref);
  }

  entries(): RefEntry[] {
    return Array.from(this.map.values());
  }

  clear(): void {
    this.map.clear();
  }

  getNextCounter(): number {
    return this.counter;
  }
}
