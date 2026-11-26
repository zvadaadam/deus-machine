import { randomBytes } from "node:crypto";
import { AppError } from "../lib/errors";
import type { BrowserFileRequest, resolveBrowserFile } from "./browser-files";

interface Entry {
  deviceId: string;
  source: BrowserFileRequest;
  realPath: string;
  type: string;
  dev: number;
  ino: number;
  expires: number;
}

const lifetime = 60 * 60 * 1000;
const capacity = 1024;
const randomHandle = () => randomBytes(16).toString("base64url");

/** Only this process can turn a handle back into the device and file it was issued for. */
export class FileHandles {
  readonly routeKey = randomHandle();
  private readonly entries = new Map<string, Entry>();

  issue(deviceId: string, file: Awaited<ReturnType<typeof resolveBrowserFile>>): string {
    const now = Date.now();
    for (const [handle, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(handle);
      else if (
        entry.deviceId === deviceId &&
        (file.source.kind === "recording"
          ? entry.source.kind === "recording"
          : entry.source.kind === "preview" &&
            entry.source.workspaceId === file.source.workspaceId) &&
        entry.realPath === file.realPath &&
        entry.dev === file.stat.dev &&
        entry.ino === file.stat.ino
      )
        return handle;
    }
    if (this.entries.size >= capacity)
      throw new AppError(429, "Too many open file links. Try again later.");
    const handle = randomHandle();
    this.entries.set(handle, {
      deviceId,
      source: file.source,
      realPath: file.realPath,
      type: file.type,
      dev: file.stat.dev,
      ino: file.stat.ino,
      expires: now + lifetime,
    });
    return handle;
  }

  lookup(handle: string): Entry | undefined {
    const entry = this.entries.get(handle);
    if (entry && entry.expires <= Date.now()) {
      this.entries.delete(handle);
      return undefined;
    }
    return entry;
  }

  revoke(deviceId: string): void {
    for (const [handle, entry] of this.entries)
      if (entry.deviceId === deviceId) this.entries.delete(handle);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const fileHandles = new FileHandles();
