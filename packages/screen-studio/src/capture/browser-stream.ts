import { join } from "node:path";
import { ScreenStudioError } from "../errors.js";
import type { Size } from "../util/units.js";
import type { ActiveCapture, CaptureBackend, CaptureContext } from "./backend.js";
import { CdpClient, finalizeFragmented, resolvePageTarget, withTimeout } from "./cdp.js";
import { FramePump } from "./frame-pump.js";
import { observePage } from "./page-observer.js";

/**
 * Record a tab from a frame stream another component already runs — e.g.
 * agent-browser's viewport stream that a product's live viewer consumes.
 *
 * A second screencast would work too (two on one tab each kept 60 fps), but
 * joining saves the browser encoding every frame twice — worth having in a
 * sandbox. Actions still come from the page itself over DevTools.
 */
export interface BrowserStreamSourceSpec {
  kind: "browser-stream";
  /** WebSocket of the stream: messages `{ type: "frame", data: <base64 JPEG>, metadata }`. */
  url: string;
  /** DevTools endpoint of the same browser, to watch the page's input. */
  cdp?: string;
  urlContains?: string;
  observe?: boolean;
}

const FIRST_FRAME_TIMEOUT_MS = 10_000;

export async function browserStreamBackend(
  spec: BrowserStreamSourceSpec,
  label?: string
): Promise<CaptureBackend> {
  const target = spec.cdp ? await resolvePageTarget(spec.cdp, spec) : null;
  return {
    id: `browser-stream:${spec.url}`,
    kind: "browser",
    backend: "frame-stream",
    label: label ?? (target?.title || target?.url || "Browser stream"),
    details: {
      stream: spec.url,
      ...(target ? { url: target.url, title: target.title, targetId: target.id } : {}),
    },
    start: (context) => startStream(spec, target?.webSocketDebuggerUrl ?? null, context),
  };
}

async function startStream(
  spec: BrowserStreamSourceSpec,
  pageWs: string | null,
  context: CaptureContext
): Promise<ActiveCapture> {
  const partPath = join(context.mediaDir, "screen.part.mp4");
  const finalPath = join(context.mediaDir, "screen.mp4");
  let stopped = false;
  let viewport: Size | null = null;
  const pump = new FramePump({
    outputPath: partPath,
    fps: context.fps,
    log: context.log,
    onUnexpectedExit: (error) => context.onFailure(error),
  });

  const ws = new WebSocket(spec.url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(unavailable(spec.url)), 5_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(unavailable(spec.url));
    };
  });
  ws.onmessage = (event) => {
    if (stopped || typeof event.data !== "string") return;
    let message: {
      type?: string;
      data?: string;
      metadata?: { deviceWidth?: number; deviceHeight?: number };
    };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== "frame" || !message.data) return;
    const { deviceWidth, deviceHeight } = message.metadata ?? {};
    if (deviceWidth && deviceHeight) {
      const next = { width: Math.round(deviceWidth), height: Math.round(deviceHeight) };
      if (viewport && (viewport.width !== next.width || viewport.height !== next.height)) {
        context.onGeometry(next);
      }
      viewport = next;
    }
    pump.push(Buffer.from(message.data, "base64"));
  };
  ws.onclose = () => {
    if (!stopped) context.onSourceLost("the browser frame stream closed");
  };

  let page: CdpClient | null = null;
  let stopObserving: (() => Promise<void>) | null = null;
  try {
    if (pageWs && spec.observe !== false && context.onEvent) {
      page = await CdpClient.connect(pageWs);
      // The stream can outlive the tab it showed: a closed tab ends the recording.
      page.onClose((reason) => {
        if (!stopped) context.onSourceLost(`browser tab disconnected: ${reason}`);
      });
      page.on("Inspector.detached", (params) => {
        if (!stopped)
          context.onSourceLost(`browser tab detached: ${String(params.reason ?? "unknown")}`);
      });
      await page.send("Page.enable");
      stopObserving = await observePage(page, context.onEvent);
    }
    await withTimeout(
      pump.ready,
      FIRST_FRAME_TIMEOUT_MS,
      () =>
        new ScreenStudioError("source_unavailable", "The frame stream sent no frames", {
          hint: "Check the browser has a visible page; streams start sending when a page paints.",
        })
    );
  } catch (err) {
    stopped = true;
    pump.kill();
    ws.close();
    page?.close();
    throw err;
  }

  return {
    mediaStartEpochMs: pump.startedAtEpochMs!,
    // Frames reach us through the stream server: a little later than direct DevTools.
    uncertaintyMs: 40,
    clockMethod: "recorder-constant-rate over a shared frame stream",
    geometry: viewport && pump.size ? { viewport, media: pump.size } : undefined,
    pointerInPixels: "none",
    childPids: pump.pid ? [pump.pid] : [],
    stats: () => ({ frames: pump.framesWritten }),
    async stop() {
      stopped = true;
      const stopAt = Date.now();
      await stopObserving?.();
      page?.close();
      ws.close();
      await pump.stop(stopAt);
      return finalizeFragmented(partPath, finalPath);
    },
  };
}

function unavailable(url: string): ScreenStudioError {
  return new ScreenStudioError("source_unavailable", `No frame stream at ${url}`, {
    hint: "For agent-browser: `agent-browser stream status` reports the port.",
  });
}
