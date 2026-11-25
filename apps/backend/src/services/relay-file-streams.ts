import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createSenderWindow, encodeChunk, MAX_CHUNK_BYTES } from "@shared/tunnel";
import type { RelayFrame, ServerFrame } from "@shared/types/relay";
import { fileRange, resolveBrowserFile } from "./browser-files";
import { fileHandles } from "./relay-file-handles";

type FileFrame = Extract<RelayFrame, { type: "file_open" | "file_credit" | "file_cancel" }>;
type FileReply = Extract<ServerFrame, { type: "file_head" | "file_end" }>;
interface Read {
  id: number;
  handle: string;
  window: ReturnType<typeof createSenderWindow>;
  timer?: ReturnType<typeof setTimeout>;
  body?: { file: FileHandle; position: number; remaining: number };
}

/** One instance per tunnel. An asynchronous disk read can only send to the socket that opened it. */
export class RelayFileStreams {
  private readonly reads = new Map<number, Read>();
  private pumping = false;

  constructor(
    private readonly reply: (frame: FileReply) => void,
    private readonly sendChunk: (frame: Uint8Array) => Promise<void>
  ) {}

  receive(frame: FileFrame): void {
    const id = frame.streamId;
    if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) return;
    const read = this.reads.get(id);
    if (frame.type === "file_open") {
      if (
        (frame.method !== "GET" && frame.method !== "HEAD") ||
        !Number.isSafeInteger(frame.credit) ||
        frame.credit < MAX_CHUNK_BYTES ||
        (frame.range !== undefined && typeof frame.range !== "string") ||
        typeof frame.handle !== "string"
      ) {
        this.refuse(id);
        return;
      }
      const entry = fileHandles.lookup(frame.handle);
      if (!entry) {
        this.refuse(id);
        return;
      }
      if (read) {
        this.finish(read, "Duplicate file open");
        return;
      }
      const next: Read = { id, handle: frame.handle, window: createSenderWindow(frame.credit) };
      this.reads.set(id, next);
      void this.open(next, entry, frame);
    } else if (read) {
      if (frame.type === "file_cancel") this.release(read);
      else if (!read.body || frame.bytes <= 0 || !read.window.grant(frame.bytes))
        this.finish(read, "Invalid file credit");
      else {
        this.arm(read);
        this.schedule();
      }
    }
  }

  private async open(
    read: Read,
    entry: NonNullable<ReturnType<typeof fileHandles.lookup>>,
    frame: Extract<FileFrame, { type: "file_open" }>
  ): Promise<void> {
    let descriptor: FileHandle | undefined;
    try {
      const file = resolveBrowserFile(entry.source);
      if (file.realPath !== entry.realPath || file.type !== entry.type)
        throw new Error("File changed");
      descriptor = await open(
        file.realPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const stat = await descriptor.stat();
      if (this.reads.get(read.id) !== read) return;
      // Check the opened descriptor against the file the device selected, even if a path was replaced during open.
      if (
        !fileHandles.lookup(read.handle) ||
        !stat.isFile() ||
        stat.dev !== entry.dev ||
        stat.ino !== entry.ino
      )
        throw new Error("File changed");
      const range = fileRange(stat.size, frame.range);
      if (range.status === 416) throw new Error("Range not satisfiable");
      this.reply({
        type: "file_head",
        streamId: read.id,
        status: range.status,
        headers: {
          ...range.headers,
          "Content-Type": file.type,
          "Accept-Ranges": "bytes",
        },
      });
      if (frame.method === "HEAD" || range.length === 0) {
        this.finish(read);
        return;
      }
      read.body = { file: descriptor, position: range.start, remaining: range.length };
      descriptor = undefined;
      this.arm(read);
      this.schedule();
    } catch {
      if (this.reads.get(read.id) !== read) return;
      this.refuse(read.id);
      this.release(read);
    } finally {
      await descriptor?.close().catch(() => {});
    }
  }

  private refuse(streamId: number): void {
    this.reply({ type: "file_head", streamId, status: 404, headers: {} });
  }

  private arm(read: Read): void {
    clearTimeout(read.timer);
    read.timer = setTimeout(() => this.finish(read, "No file credit"), 60_000);
  }

  private schedule(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => void this.pump());
  }

  private async pump(): Promise<void> {
    for (const read of this.reads.values()) {
      const body = read.body;
      if (!body) continue;
      const count = Math.min(MAX_CHUNK_BYTES, body.remaining);
      if (!read.window.trySend(count)) continue;
      try {
        const bytes = Buffer.allocUnsafe(count);
        let filled = 0;
        while (filled < count) {
          const { bytesRead } = await body.file.read(
            bytes,
            filled,
            count - filled,
            body.position + filled
          );
          if (!bytesRead) throw new Error("File truncated");
          if (this.reads.get(read.id) !== read) break;
          filled += bytesRead;
        }
        if (this.reads.get(read.id) === read) {
          if (!fileHandles.lookup(read.handle)) throw new Error("File link expired");
          // JSON can be sent while this chunk drains. No other file chunk is queued ahead of it.
          await this.sendChunk(encodeChunk(read.id, bytes));
          if (this.reads.get(read.id) !== read) continue;
          body.position += count;
          body.remaining -= count;
          if (!body.remaining) this.finish(read);
          else {
            // Reads that became ready while this chunk was on disk get the next turn.
            this.reads.delete(read.id);
            this.reads.set(read.id, read);
          }
        }
      } catch {
        if (this.reads.get(read.id) === read) this.finish(read, "File read failed");
      }
      // Yield between chunks so incoming requests and their JSON replies can run.
      setImmediate(() => void this.pump());
      return;
    }
    this.pumping = false;
  }

  private finish(read: Read, error?: string): void {
    this.release(read);
    this.reply({ type: "file_end", streamId: read.id, error });
  }

  private release(read: Read): void {
    clearTimeout(read.timer);
    this.reads.delete(read.id);
    void read.body?.file.close().catch(() => {});
  }

  disconnect(): void {
    for (const read of this.reads.values()) this.release(read);
  }
}
