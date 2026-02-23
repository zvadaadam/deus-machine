// gateway/lib/binding-store.ts
// Maps (channel, chatId) → workspace/session binding.
// Persisted to a JSON file — simple, no SQLite dependency needed.

import * as fs from "fs";
import type { Channel, ChannelBinding } from "../types";

/** Composite key for the binding map */
function bindingKey(channel: Channel, chatId: string): string {
  return `${channel}:${chatId}`;
}

export class BindingStore {
  private bindings = new Map<string, ChannelBinding>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** Get the binding for a specific chat */
  get(channel: Channel, chatId: string): ChannelBinding | undefined {
    return this.bindings.get(bindingKey(channel, chatId));
  }

  /** Set or update a binding */
  set(binding: ChannelBinding): void {
    this.bindings.set(bindingKey(binding.channel, binding.chatId), binding);
    this.persist();
  }

  /** Remove a binding */
  remove(channel: Channel, chatId: string): boolean {
    const removed = this.bindings.delete(bindingKey(channel, chatId));
    if (removed) this.persist();
    return removed;
  }

  /** Get all bindings */
  all(): ChannelBinding[] {
    return [...this.bindings.values()];
  }

  /** Get all bindings for a specific workspace */
  byWorkspace(workspaceId: string): ChannelBinding[] {
    return [...this.bindings.values()].filter((b) => b.workspaceId === workspaceId);
  }

  /** Load bindings from disk */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const arr = JSON.parse(raw) as ChannelBinding[];
        for (const b of arr) {
          this.bindings.set(bindingKey(b.channel, b.chatId), b);
        }
      }
    } catch (err) {
      console.error("[BindingStore] Failed to load bindings:", err);
    }
  }

  /** Persist bindings to disk */
  private persist(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify([...this.bindings.values()], null, 2));
    } catch (err) {
      console.error("[BindingStore] Failed to persist bindings:", err);
    }
  }
}
