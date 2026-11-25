import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as tunnel from "@shared/tunnel";
import { decodeChunk, DEFAULT_WINDOW_BYTES, MAX_CHUNK_BYTES } from "@shared/tunnel";
import type { ServerFrame } from "@shared/types/relay";
import { resolveBrowserFile } from "../../../src/services/browser-files";
import { fileHandles } from "../../../src/services/relay-file-handles";
import { RelayFileStreams } from "../../../src/services/relay-file-streams";

const io = vi.hoisted(() => ({ opens: 0, closed: 0, short: Infinity }));
vi.mock("node:fs/promises", async (original) => {
  const disk = await original<typeof import("node:fs/promises")>();
  return {
    ...disk,
    open: async (...args: Parameters<typeof disk.open>) => {
      io.opens++;
      const f = await disk.open(...args);
      return {
        stat: () => f.stat(),
        read: (b: Buffer, offset: number, length: number, pos: number) =>
          f.read(b, offset, Math.min(length, io.short), pos),
        close: async () => {
          await f.close();
          io.closed++;
        },
      };
    },
  };
});

const wire: ServerFrame[] = [];
const chunks: { id: number; bytes: Buffer }[] = [];
const sent = vi.fn<() => Promise<void>>();
function sendChunk(frame: Uint8Array) {
  const chunk = decodeChunk(frame);
  if (!chunk.ok) throw new Error(chunk.error);
  chunks.push({ id: chunk.streamId, bytes: Buffer.from(chunk.payload) });
  return sent();
}
let dir: string, file: string, handle: string, host: RelayFileStreams;
const contents = Buffer.alloc(DEFAULT_WINDOW_BYTES + MAX_CHUNK_BYTES + 1);
for (let i = 0; i < contents.length; i++) contents[i] = i % 251;
const request = (
  id: number,
  extra: Partial<{ handle: string; method: "GET" | "HEAD"; range: string; credit: number }> = {}
) =>
  host.receive({
    type: "file_open",
    streamId: id,
    credit: DEFAULT_WINDOW_BYTES,
    handle,
    method: "GET",
    ...extra,
  });
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000, interval: 5 });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-file-test-"));
  file = path.join(dir, "recording.mp4");
  fs.writeFileSync(file, contents);
  const input = { kind: "recording" as const, path: file };
  handle = fileHandles.issue("phone", resolveBrowserFile(input));
  host = new RelayFileStreams((f) => wire.push(f), sendChunk);
  io.opens = 0;
  io.closed = 0;
  io.short = Infinity;
  wire.length = 0;
  chunks.length = 0;
  sent.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  host.disconnect();
  fileHandles.clear();
  vi.useRealTimers();
  await wait(() => expect(io.closed).toBe(io.opens));
  fs.rmSync(dir, { recursive: true, force: true });
});

it("validates the open and looks up the handle before touching disk", () => {
  const reserve = vi.spyOn(tunnel, "createSenderWindow");
  const resolve = vi.spyOn(fs, "realpathSync");
  try {
    request(1, { credit: 0 });
    request(2, { handle: "unknown" });
    expect(wire).toEqual([
      { type: "file_head", streamId: 1, status: 404, headers: {} },
      { type: "file_head", streamId: 2, status: 404, headers: {} },
    ]);
    expect(reserve).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(io.opens).toBe(0);
  } finally {
    reserve.mockRestore();
    resolve.mockRestore();
  }
});

it("answers HEAD, an unsatisfiable range and a changed file without sending bytes", async () => {
  request(1, { method: "HEAD", range: "bytes=5-10" });
  request(2, { range: `bytes=${contents.length}-` });
  await wait(() => expect(io.closed).toBe(2));
  expect(wire).toContainEqual({
    type: "file_head",
    streamId: 1,
    status: 206,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": "6",
      "Content-Range": `bytes 5-10/${contents.length}`,
      "Accept-Ranges": "bytes",
    },
  });
  expect(wire).toContainEqual({ type: "file_head", streamId: 2, status: 404, headers: {} });
  fs.renameSync(file, file + ".old");
  fs.writeFileSync(file, "replacement");
  request(3);
  await wait(() => expect(io.closed).toBe(3));
  expect(wire).toContainEqual({ type: "file_head", streamId: 3, status: 404, headers: {} });
  expect(chunks).toHaveLength(0);
});

it("assembles short disk reads into ordered full chunks and resumes only within returned credit", async () => {
  io.short = 51003;
  request(1);
  await wait(() => expect(chunks).toHaveLength(DEFAULT_WINDOW_BYTES / MAX_CHUNK_BYTES));
  expect(chunks.every((c) => c.bytes.length === MAX_CHUNK_BYTES)).toBe(true);
  expect(wire.some((f) => f.type === "file_end")).toBe(false);
  host.receive({ type: "file_credit", streamId: 1, bytes: MAX_CHUNK_BYTES });
  await wait(() => expect(chunks).toHaveLength(5));
  host.receive({ type: "file_credit", streamId: 1, bytes: 1 });
  await wait(() => expect(io.closed).toBe(1));
  expect(chunks.at(-1)?.bytes.length).toBe(1);
  expect(Buffer.concat(chunks.map((c) => c.bytes)).equals(contents)).toBe(true);
  expect(wire.at(-1)).toMatchObject({ type: "file_end", streamId: 1 });
});

it("uses a relay's announced 2 MiB window without waiting for a further credit", async () => {
  request(1, { credit: 2 * 1024 * 1024 });
  await wait(() => expect(wire.length).toBeGreaterThan(0));
  expect(wire[0]).toMatchObject({ type: "file_head", status: 200 });
  await wait(() => expect(io.closed).toBe(1));
  expect(Buffer.concat(chunks.map((chunk) => chunk.bytes)).equals(contents)).toBe(true);
});

it("reports an error after the head if the file shrinks before the next chunk", async () => {
  sent.mockImplementationOnce(async () => fs.truncateSync(file, MAX_CHUNK_BYTES + 3));
  request(1);
  await wait(() => expect(io.closed).toBe(1));
  expect(wire[0]).toMatchObject({ type: "file_head", status: 200 });
  expect(chunks).toHaveLength(1);
  expect(wire.at(-1)).toMatchObject({ type: "file_end", streamId: 1, error: expect.any(String) });
});

it("waits for a chunk's send callback before starting the next stream's turn", async () => {
  let drained!: () => void;
  sent.mockImplementationOnce(() => new Promise<void>((resolve) => (drained = resolve)));
  request(1, { range: `bytes=0-${MAX_CHUNK_BYTES}` });
  request(2, { range: `bytes=0-${MAX_CHUNK_BYTES}` });
  await wait(() => expect(wire).toHaveLength(2));
  await wait(() => expect(sent).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(chunks).toHaveLength(1);
  drained();
  await wait(() => expect(io.closed).toBe(2));
  const first = chunks[0].id;
  expect(chunks.map((c) => c.id)).toEqual([first, 3 - first, first, 3 - first]);
});

it("closes cancelled reads and every descriptor on tunnel disconnect", async () => {
  let drained!: () => void;
  sent.mockImplementationOnce(() => new Promise<void>((resolve) => (drained = resolve)));
  request(1, { range: "bytes=0-10" });
  request(2, { range: "bytes=0-10" });
  await wait(() => expect(wire).toHaveLength(2));
  await wait(() => expect(chunks).toHaveLength(1));
  host.receive({ type: "file_cancel", streamId: chunks[0].id });
  await wait(() => expect(io.closed).toBe(1));
  host.disconnect();
  await wait(() => expect(io.closed).toBe(2));
  drained();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(wire.some((frame) => frame.type === "file_end")).toBe(false);
  expect(chunks).toHaveLength(1);
});

it("ends a stalled read after sixty seconds without credit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  request(1);
  await wait(() => expect(chunks).toHaveLength(4));
  await vi.advanceTimersByTimeAsync(59_000);
  expect(wire.some((f) => f.type === "file_end")).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(wire.at(-1)).toMatchObject({ type: "file_end", streamId: 1, error: "No file credit" });
});

it("keeps the selected file after a symlink is removed and stops granting bytes on device revocation", async () => {
  const alias = path.join(dir, "alias.mp4");
  fs.symlinkSync(file, alias);
  fileHandles.clear();
  handle = fileHandles.issue("phone", resolveBrowserFile({ kind: "recording", path: alias }));
  fs.unlinkSync(alias);
  request(1);
  await wait(() => expect(chunks).toHaveLength(4));
  fileHandles.revoke("phone");
  host.receive({ type: "file_credit", streamId: 1, bytes: MAX_CHUNK_BYTES });
  await wait(() => expect(io.closed).toBe(1));
  expect(wire.at(-1)).toMatchObject({ type: "file_end", streamId: 1, error: expect.any(String) });
  expect(chunks).toHaveLength(4);
});
