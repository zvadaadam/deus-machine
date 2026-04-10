import type { Part } from "@shared/messages";

export class PartsAccumulator {
  private messages = new Map<string, Map<string, Part>>();

  accumulate(messageId: string, parts: Part[]): void {
    if (parts.length === 0) return;
    let partMap = this.messages.get(messageId);
    if (!partMap) {
      partMap = new Map();
      this.messages.set(messageId, partMap);
    }
    for (const part of parts) {
      partMap.set(part.id, part);
    }
  }

  flush(messageId: string): Part[] {
    const partMap = this.messages.get(messageId);
    if (!partMap) return [];
    const parts = Array.from(partMap.values());
    this.messages.delete(messageId);
    return parts;
  }

  has(messageId: string): boolean {
    return this.messages.has(messageId);
  }

  size(): number {
    return this.messages.size;
  }
}
