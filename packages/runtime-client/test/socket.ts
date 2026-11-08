import type { RuntimeSocket } from "../src/index";

export class Socket implements RuntimeSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener<T extends "open" | "close" | "message" | "error">(
    type: T,
    callback: (
      event: {
        open: undefined;
        close: { code: number; reason: string };
        message: { data: unknown };
        error: undefined;
      }[T]
    ) => void
  ) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback as (event: unknown) => void);
    this.listeners.set(type, callbacks);
  }
  emit(type: string, event: unknown = {}) {
    this.listeners.get(type)?.forEach((callback) => callback(event));
  }
  message(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  send(raw: string) {
    if (this.readyState !== 1) throw new Error("closed");
    this.sent.push(JSON.parse(raw));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", { code, reason: "test close" });
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  frames(type: string) {
    return this.sent.filter((frame) => frame.type === type);
  }
}
