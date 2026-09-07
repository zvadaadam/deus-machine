import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as os from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  responses: [] as Array<{
    statusCode: number;
    headers?: Record<string, string | string[] | undefined>;
    body?: string | Buffer;
  }>,
  requests: [] as string[],
}));

// Mock `node:https` to mirror the real implementation's synchronous URL
// validation (`https.get("")` and `https.get("/foo")` throw `TypeError:
// Invalid URL` synchronously) and to invoke the response callback on a later
// event-loop tick via `setImmediate` — the exact path through which a throw
// inside the response callback would escape the Promise executor.
vi.mock("node:https", () => ({
  get: (
    url: string | URL,
    _opts: unknown,
    cb: (
      res: {
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
      } & PassThrough
    ) => void
  ): unknown => {
    mocks.requests.push(String(url));
    // Reproduce real https.get's synchronous URL validation: a non-absolute
    // URL throws TypeError: Invalid URL before any I/O is scheduled.
    new URL(String(url));
    const req = new EventEmitter() as unknown as http.ClientRequest;
    (req as unknown as { destroy: (err?: Error) => unknown }).destroy = () => req;
    setImmediate(() => {
      const spec = mocks.responses.shift() ?? {
        statusCode: 599,
        headers: {},
      };
      const res = new PassThrough();
      (res as unknown as { statusCode: number }).statusCode = spec.statusCode;
      (res as unknown as { headers: Record<string, string | string[] | undefined> }).headers =
        spec.headers ?? {};
      cb(res as never);
      if (spec.statusCode === 200) {
        setImmediate(() => {
          if (spec.body) res.write(Buffer.from(spec.body as string | Buffer));
          res.end();
        });
      }
    });
    return req;
  },
}));

import { downloadStream } from "../src/lib/editor-bundle.ts";

function queueResponse(spec: {
  statusCode: number;
  headers?: Record<string, string | string[] | undefined>;
  body?: string | Buffer;
}): void {
  mocks.responses.push(spec);
}

describe("downloadStream — redirect handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.requests.length = 0;
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), "pencil-editor-bundle-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects cleanly when a 3xx response has no Location header", async () => {
    queueResponse({ statusCode: 302, headers: {} });
    await expect(
      downloadStream("https://example.com/bundle.zip", join(tmpDir, "out.zip"))
    ).rejects.toThrow(/no Location/);
    expect(mocks.requests).toEqual(["https://example.com/bundle.zip"]);
  });

  it("resolves a relative Location against the current URL and follows it", async () => {
    queueResponse({ statusCode: 302, headers: { location: "/bar/baz.zip" } });
    queueResponse({ statusCode: 200, body: "ZIP-CONTENTS" });
    const dest = join(tmpDir, "out.zip");
    await expect(
      downloadStream("https://example.com/foo/bundle.zip", dest)
    ).resolves.toBeUndefined();
    expect(mocks.requests).toEqual([
      "https://example.com/foo/bundle.zip",
      "https://example.com/bar/baz.zip",
    ]);
    expect(fs.readFileSync(dest, "utf8")).toBe("ZIP-CONTENTS");
  });

  it("follows an absolute Location header", async () => {
    queueResponse({ statusCode: 301, headers: { location: "https://cdn.example.com/b.zip" } });
    queueResponse({ statusCode: 200, body: "DATA" });
    const dest = join(tmpDir, "out.zip");
    await downloadStream("https://example.com/x.zip", dest);
    expect(mocks.requests).toEqual(["https://example.com/x.zip", "https://cdn.example.com/b.zip"]);
    expect(fs.readFileSync(dest, "utf8")).toBe("DATA");
  });

  it("rejects with a descriptive error for a syntactically invalid Location", async () => {
    queueResponse({ statusCode: 302, headers: { location: "https://example.com:abc" } });
    await expect(
      downloadStream("https://example.com/b.zip", join(tmpDir, "out.zip"))
    ).rejects.toThrow(/invalid Location "https:\/\/example\.com:abc"/);
    expect(mocks.requests).toEqual(["https://example.com/b.zip"]);
  });

  it("rejects after more than the maximum number of redirects", async () => {
    for (let i = 0; i < 4; i++) {
      queueResponse({ statusCode: 302, headers: { location: "https://example.com/loop" } });
    }
    await expect(
      downloadStream("https://example.com/b.zip", join(tmpDir, "out.zip"))
    ).rejects.toThrow(/too many redirects/);
    // Three follow-on attempts beyond the original = 4 https.get calls total
    // before the 4th redirect branch rejects the promise.
    expect(mocks.requests.length).toBe(4);
  });

  it("rejects on a non-200/non-3xx status with the canonical error wording", async () => {
    queueResponse({ statusCode: 404 });
    await expect(
      downloadStream("https://example.com/b.zip", join(tmpDir, "out.zip"))
    ).rejects.toThrow(/HTTP 404 fetching https:\/\/example\.com\/b\.zip/);
    expect(mocks.requests).toEqual(["https://example.com/b.zip"]);
  });

  it("writes the 200 response body to destPath and resolves", async () => {
    queueResponse({ statusCode: 200, body: "DATA" });
    const dest = join(tmpDir, "out.zip");
    await expect(downloadStream("https://example.com/b.zip", dest)).resolves.toBeUndefined();
    expect(fs.readFileSync(dest, "utf8")).toBe("DATA");
  });

  it("follows a chain of relative redirects, resolving at each hop", async () => {
    queueResponse({ statusCode: 307, headers: { location: "/path2" } });
    queueResponse({ statusCode: 307, headers: { location: "/path3" } });
    queueResponse({ statusCode: 200, body: "FINAL" });
    const dest = join(tmpDir, "out.zip");
    await downloadStream("https://example.com/path1", dest);
    expect(mocks.requests).toEqual([
      "https://example.com/path1",
      "https://example.com/path2",
      "https://example.com/path3",
    ]);
    expect(fs.readFileSync(dest, "utf8")).toBe("FINAL");
  });

  it("converts a synchronous https.get throw on the initial URL to a rejection", async () => {
    // The empty-string initial URL is the exact case the original `?? ""`
    // fallback made worse. The fix's try/catch around https.get must capture
    // this and produce a Promise rejection rather than an uncaughtException.
    await expect(downloadStream("", join(tmpDir, "out.zip"))).rejects.toThrow(/Invalid URL/);
    expect(mocks.requests).toEqual([""]);
  });

  it("converts a synchronous https.get throw on a relative initial URL to a rejection", async () => {
    // Same shape but for a relative URL fed in directly (not via Location).
    await expect(downloadStream("/foo", join(tmpDir, "out.zip"))).rejects.toThrow(/Invalid URL/);
    expect(mocks.requests).toEqual(["/foo"]);
  });
});
