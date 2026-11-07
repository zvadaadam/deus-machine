import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createBundle, readEvents, readManifest } from "../src/bundle/bundle.js";
import { ManifestSchema } from "../src/bundle/schema.js";
import { resolvePageTarget } from "../src/capture/cdp.js";
import { FramePump } from "../src/capture/frame-pump.js";
import { parseSourceId, resolveSource } from "../src/capture/sources.js";
import { startRecording } from "../src/recorder.js";
import { probeMedia } from "../src/util/ffmpeg.js";
import { jpegFrames, manifest, tempDir } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("source IDs", () => {
  it("parses every documented form", () => {
    expect(parseSourceId("browser:http://127.0.0.1:9222")).toEqual({
      kind: "browser",
      endpoint: "http://127.0.0.1:9222",
    });
    expect(parseSourceId("agent-browser:ns/demo")).toEqual({
      kind: "agent-browser",
      namespace: "ns",
      session: "demo",
    });
    expect(parseSourceId("ios-simulator")).toEqual({ kind: "ios-simulator", udid: "booted" });
    expect(parseSourceId("display:1")).toEqual({ kind: "display", screen: 1 });
    expect(parseSourceId("test-pattern:640x360")).toEqual({
      kind: "test-pattern",
      size: { width: 640, height: 360 },
    });
    expect(() => parseSourceId("webcam")).toThrow(/Unknown source/);
  });
});

describe("frame pump", () => {
  it("turns sporadic frames into constant-rate video that covers the whole window", async () => {
    const dir = tempDir();
    const [a, b] = jpegFrames(2);
    const pump = new FramePump({ outputPath: join(dir, "out.mp4"), fps: 30 });
    const start = Date.now();
    pump.push(a, start);
    await pump.ready;
    await sleep(700);
    pump.push(b);
    await sleep(600);
    const { frames } = await pump.stop(start + 2000);
    expect(frames).toBe(61);
    const probe = await probeMedia(join(dir, "out.mp4"));
    expect(Math.abs(probe.durationMs - 2033)).toBeLessThan(80);
  });
});

describe("recorder", () => {
  it("records, accepts events, and finalizes verified media once", async () => {
    const dir = join(tempDir(), "bundle");
    const recording = await startRecording({
      source: "test-pattern:320x240",
      out: dir,
      maxDurationMs: 60_000,
    });
    expect(recording.manifest.status).toBe("recording");
    await recording.chapter("Start");
    await recording.action({ type: "click", rect: { x: 10, y: 10, width: 50, height: 20 } });
    await sleep(1200);
    const [first, second] = await Promise.all([recording.stop(), recording.stop()]);
    expect(first).toBe(second);
    expect(first.status).toBe("complete");
    expect(first.media!.frames).toBeGreaterThan(20);
    expect(first.media!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await readEvents(dir)).events.map((e) => e.kind)).toEqual(["chapter", "action"]);
    await expect(recording.chapter("Too late")).rejects.toThrow(/complete/);
  });

  it("never leaves an unhandled rejection behind a normal stop", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    // A source ID is resolved inside startRecording; a resolved backend is not.
    for (const source of ["test-pattern:320x240", await resolveSource("test-pattern:320x240")]) {
      const recording = await startRecording({ source, out: join(tempDir(), "b") });
      await recording.stop();
    }
    await sleep(100);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("keeps the clock of a recording stopped while it started", async () => {
    const real = await resolveSource("test-pattern:320x240");
    const controller = new AbortController();
    const recording = await startRecording({
      source: {
        ...real,
        start: async (context) => {
          const capture = await real.start(context);
          controller.abort(); // a stop arrives as the first frames do
          return capture;
        },
      },
      out: join(tempDir(), "bundle"),
      signal: controller.signal,
    });
    const final = await recording.finished;
    expect(final.status).toBe("complete");
    expect(final.clock?.mediaStartEpochMs).toBeGreaterThan(0);
    expect(final.capture.startedAt).toBe(final.clock?.mediaStartEpochMs);
  });

  it("survives events it cannot write", async () => {
    const real = await resolveSource("test-pattern:320x240");
    const dir = join(tempDir(), "bundle");
    const recording = await startRecording({
      source: {
        ...real,
        start: async (context) => {
          const capture = await real.start(context);
          // The events file becomes unwritable (as on a full disk).
          rmSync(join(dir, "events.jsonl"), { force: true });
          mkdirSync(join(dir, "events.jsonl"));
          context.onEvent?.({ kind: "note", text: "lost" });
          context.onGeometry({ width: 10, height: 10 });
          return capture;
        },
      },
      out: dir,
    });
    await sleep(300);
    expect((await recording.stop()).status).toBe("complete");
  });

  it("registers a detached worker as a worker, even before its spawner does", async () => {
    // The worker can read the bundle before startDetached records it as owner.
    const dir = join(tempDir(), "bundle");
    await createBundle(dir, {
      source: { id: "test-pattern", kind: "browser", backend: "pending", label: "t", details: {} },
      capture: { fps: 30, maxDurationMs: 60_000, maxBytes: 1e9, requestedAt: 0, warnings: [] },
    });
    const recording = await startRecording({
      source: "test-pattern:320x240",
      out: dir,
      existing: true,
    });
    expect((await readManifest(dir)).capture.owner).toMatchObject({
      kind: "worker",
      pid: process.pid,
    });
    await recording.stop();
  });

  it("refuses owner PIDs that would signal the wrong processes", () => {
    const m = manifest();
    const owner = { pid: 4242, hostname: "h", token: "t", kind: "worker", childPids: [] };
    const parse = (o: object) =>
      ManifestSchema.safeParse({ ...m, capture: { ...m.capture, owner: o } }).success;
    expect(parse(owner)).toBe(true);
    expect(parse({ ...owner, pid: -4242 })).toBe(false);
    expect(parse({ ...owner, pid: 1 })).toBe(false);
    expect(parse({ ...owner, childPids: [0] })).toBe(false);
  });

  it("stops itself at the deadline", async () => {
    const dir = join(tempDir(), "bundle");
    const recording = await startRecording({
      source: "test-pattern:320x240",
      out: dir,
      maxDurationMs: 1500,
    });
    const final = await recording.finished;
    expect(final.capture.stopReason).toBe("deadline");
    expect(final.media!.durationMs).toBeGreaterThan(1200);
    expect(final.media!.durationMs).toBeLessThan(2500);
  });

  it("refuses to overwrite an existing recording and records failures", async () => {
    const dir = join(tempDir(), "bundle");
    const recording = await startRecording({
      source: "test-pattern:320x240",
      out: dir,
      maxDurationMs: 800,
    });
    await recording.finished;
    await expect(startRecording({ source: "test-pattern", out: dir })).rejects.toMatchObject({
      code: "bundle_exists",
    });
    const failed = join(tempDir(), "bundle");
    await expect(
      startRecording({ source: "browser:http://127.0.0.1:1", out: failed })
    ).rejects.toMatchObject({ code: "source_unavailable" });
    expect((await readManifest(failed)).status).toBe("failed");
  });
});

describe("CDP screencast", () => {
  let server: Server;
  let port: number;
  const sockets: WsSocket[] = [];
  let size = { width: 64, height: 48 };
  const frames = jpegFrames(3);

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/json/list") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify([
            {
              id: "INTERNAL",
              type: "page",
              title: "New Tab",
              url: "chrome://newtab/",
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/INTERNAL`,
            },
            {
              id: "APP",
              type: "page",
              title: "App",
              url: "http://localhost:3000/login",
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/APP`,
            },
          ])
        );
      } else res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
      sockets.push(ws);
      let timer: ReturnType<typeof setInterval> | null = null;
      let n = 0;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { id: number; method: string };
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        if (msg.method === "Runtime.addBinding") {
          // The page reports a press then a click on a button, as a driven tab
          // would. Then it is hidden: an idle report from one document, a
          // navigation, one from the next a second later, and its first painted
          // frame. One busy pause reported twice in a moment (an overdue timer,
          // then leaving the page) is not a gap. Hidden again, it never paints
          // before the recording ends.
          const now = Date.now();
          const rect = { x: 10, y: 12, width: 30, height: 14 };
          for (const [delay, payload] of [
            [400, { t: "down", at: now + 400, x: 25, y: 19, rect, label: "Save" }],
            [480, { t: "click", at: now + 480, x: 25, y: 19, rect, label: "Save" }],
            [490, { t: "hover", at: now + 490, x: 60, y: 19, rect, label: "Menu" }],
            [500, { t: "idle", at: now + 100, endAt: now + 200 }],
            [505, { t: "idle", at: now + 300, endAt: now + 1000 }],
            [510, { t: "painted", at: now + 1050 }],
            [515, { t: "idle", at: now + 1060, endAt: now + 1100 }],
            [520, { t: "idle", at: now + 1060, endAt: now + 1105 }],
            [525, { t: "painted", at: now + 1110 }],
            [530, { t: "idle", at: now + 1120, endAt: now + 1130 }],
            [535, { t: "idle", at: now + 1120, endAt: now + 1900 }],
          ] as const) {
            setTimeout(() => {
              if (ws.readyState !== ws.OPEN) return;
              ws.send(
                JSON.stringify({
                  method: "Runtime.bindingCalled",
                  params: { name: "__screenStudioObserve", payload: JSON.stringify(payload) },
                })
              );
            }, delay);
          }
        }
        if (msg.method === "Page.startScreencast") {
          const send = () =>
            ws.send(
              JSON.stringify({
                method: "Page.screencastFrame",
                params: {
                  sessionId: ++n,
                  data: frames[n % frames.length].toString("base64"),
                  metadata: { deviceWidth: size.width, deviceHeight: size.height },
                },
              })
            );
          send();
          timer = setInterval(send, 250);
        }
        if (msg.method === "Page.stopScreencast" && timer) clearInterval(timer);
      });
      ws.on("close", () => timer && clearInterval(timer));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it("picks the ordinary tab, or the one whose URL matches", async () => {
    expect((await resolvePageTarget(`http://127.0.0.1:${port}`)).id).toBe("APP");
    expect((await resolvePageTarget(`${port}`, { urlContains: "newtab" })).id).toBe("INTERNAL");
    await expect(resolvePageTarget(`${port}`, { urlContains: "nope" })).rejects.toMatchObject({
      code: "source_not_found",
    });
  });

  it("captures frames, records viewport changes, and stops when the tab goes away", async () => {
    const dir = join(tempDir(), "bundle");
    const recording = await startRecording({
      source: `browser:http://127.0.0.1:${port}`,
      out: dir,
    });
    expect(recording.manifest.source).toMatchObject({
      kind: "browser",
      backend: "cdp-screencast",
      details: { url: "http://localhost:3000/login" },
    });
    expect(recording.manifest.geometry).toEqual({
      viewport: { width: 64, height: 48 },
      media: { width: 64, height: 48 },
    });
    await sleep(600);
    size = { width: 80, height: 60 };
    await sleep(600);
    for (const socket of sockets) socket.close();
    const final = await recording.finished;
    expect(final.status).toBe("complete");
    expect(final.capture.stopReason).toBe("source-lost");
    expect(final.media!.durationMs).toBeGreaterThan(900);
    const { events } = await readEvents(dir);
    expect(events.find((e) => e.kind === "geometry")).toMatchObject({
      viewport: { width: 80, height: 60 },
    });
    const click = events.find((e) => e.kind === "action");
    expect(click).toMatchObject({
      type: "click",
      by: "page",
      label: "Save",
      point: { x: 25, y: 19 },
    });
    expect(click?.kind === "action" && click.endAt! - click.at).toBe(80);
    expect(events.find((e) => e.kind === "action" && e.type === "hover")).toMatchObject({
      label: "Menu",
      point: { x: 60, y: 19 },
    });
    const unseen = events.flatMap((e) => (e.kind === "unseen" ? [e] : []));
    expect(unseen).toHaveLength(2);
    expect(unseen[0].endAt - unseen[0].at).toBe(950);
    expect(unseen[1].endAt).toBeGreaterThan(unseen[1].at);
  });

  it("ends a joined frame stream when its tab closes", async () => {
    // A viewer stream that keeps sending frames after the tab is gone.
    const stream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => stream.once("listening", r));
    stream.on("connection", (ws) => {
      const timer = setInterval(
        () =>
          ws.send(
            JSON.stringify({
              type: "frame",
              data: frames[0].toString("base64"),
              metadata: { deviceWidth: 64, deviceHeight: 48 },
            })
          ),
        100
      );
      ws.on("close", () => clearInterval(timer));
    });
    try {
      const recording = await startRecording({
        source: {
          kind: "browser-stream",
          url: `ws://127.0.0.1:${(stream.address() as AddressInfo).port}`,
          cdp: `http://127.0.0.1:${port}`,
        },
        out: join(tempDir(), "bundle"),
      });
      await sleep(500);
      for (const socket of sockets) socket.close();
      const final = await recording.finished;
      expect(final.capture.stopReason).toBe("source-lost");
    } finally {
      stream.close();
    }
  });
});
