import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { readEvents, readManifest } from "../src/bundle/bundle.js";
import { resolvePageTarget } from "../src/capture/cdp.js";
import { FramePump } from "../src/capture/frame-pump.js";
import { parseSourceId, resolveSource } from "../src/capture/sources.js";
import { startRecording } from "../src/recorder.js";
import { probeMedia } from "../src/util/ffmpeg.js";
import { jpegFrames, tempDir } from "./helpers.js";

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
          // would — then the span it went without being painted.
          const now = Date.now();
          const rect = { x: 10, y: 12, width: 30, height: 14 };
          for (const [delay, payload] of [
            [400, { t: "down", at: now + 400, x: 25, y: 19, rect, label: "Save" }],
            [480, { t: "click", at: now + 480, x: 25, y: 19, rect, label: "Save" }],
            [520, { t: "unseen", at: now + 500, endAt: now + 2500 }],
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
    const hidden = events.find((e) => e.kind === "unseen");
    expect(hidden?.kind === "unseen" && hidden.endAt - hidden.at).toBe(2000);
  });
});
