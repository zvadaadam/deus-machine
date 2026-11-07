import { findDeveloperDir } from "./capture/simulator.js";
import { loadCanvas } from "./render/painter.js";
import { ffmpegBin, ffmpegVersion, hasEncoder } from "./util/ffmpeg.js";
import { run } from "./util/process.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** What it enables, so a missing optional piece reads as a limitation, not an error. */
  needed: "required" | "browser" | "ios-simulator" | "display" | "styled renders";
  hint?: string;
}

/** Report what is installed. Never starts a capture or changes system settings. */
export async function doctor(): Promise<{ ok: boolean; platform: string; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const ffmpeg = await ffmpegVersion();
  checks.push({
    name: "ffmpeg",
    ok: ffmpeg !== null,
    detail: ffmpeg ? `${ffmpegBin()} ${ffmpeg}` : "not found",
    needed: "required",
    ...(ffmpeg
      ? {}
      : { hint: process.platform === "darwin" ? "brew install ffmpeg" : "Install ffmpeg" }),
  });
  if (ffmpeg) {
    const x264 = await hasEncoder("libx264");
    checks.push({
      name: "libx264",
      ok: x264,
      detail: x264 ? "available" : "missing",
      needed: "required",
    });
  }
  const canvas = await loadCanvas();
  checks.push({
    name: "@napi-rs/canvas",
    ok: canvas !== null,
    detail: canvas
      ? "available"
      : "not installed: renders fall back to FFmpeg only (no pointer, zoom or frame)",
    needed: "styled renders",
    ...(canvas ? {} : { hint: "bun add @napi-rs/canvas" }),
  });
  checks.push({
    name: "WebSocket",
    ok: typeof WebSocket === "function",
    detail:
      typeof WebSocket === "function"
        ? "global WebSocket available"
        : "missing: use Node 22+ or Bun",
    needed: "browser",
  });
  const agentBrowser = await run(process.env.AGENT_BROWSER_BIN ?? "agent-browser", ["--version"], {
    timeoutMs: 10_000,
  }).catch(() => null);
  checks.push({
    name: "agent-browser",
    ok: agentBrowser?.code === 0,
    detail:
      agentBrowser?.code === 0
        ? agentBrowser.stdout.trim()
        : "not found (only needed for agent-browser:<session> sources)",
    needed: "browser",
  });
  if (process.platform === "darwin") {
    const developerDir = await findDeveloperDir();
    checks.push({
      name: "Xcode simctl",
      ok: developerDir !== null,
      detail: developerDir ?? "no Xcode with simctl found",
      needed: "ios-simulator",
      ...(developerDir
        ? {}
        : { hint: "Install Xcode, or set DEVELOPER_DIR to …/Xcode.app/Contents/Developer" }),
    });
    checks.push({
      name: "Screen Recording permission",
      ok: true,
      detail:
        "Not checked without capturing: macOS grants it per app. A denied display capture reports permission_denied.",
      needed: "display",
    });
  }
  return {
    ok: checks.filter((c) => c.needed === "required").every((c) => c.ok),
    platform: `${process.platform}-${process.arch}`,
    checks,
  };
}
