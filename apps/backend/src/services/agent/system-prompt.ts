// backend/src/services/agent/system-prompt.ts
// The deus system-prompt append, fed to the embedded engine as
// RunConfig.systemPromptAppend. Ported verbatim from the legacy handlers:
// claude got workspace context + the screen-recording tool briefing (the
// recording tools live in the in-process deus MCP suite); the codex harnesses
// got workspace context only (they run without the deus tool suite).

import { buildWorkspaceContext } from "./workspace-context";

const FALLBACK_CONTEXT =
  "You are working inside Deus, a desktop app that orchestrates multiple AI coding agents in parallel.";

const SCREEN_RECORDING = `
# Screen Recording

You have screen recording tools available directly — just call them, do NOT search for them with ToolSearch. The tools are: recording_start, recording_chapter, recording_status, recording_stop.

**Events are captured automatically.** When a recording is active, every browser tool you use (BrowserClick, BrowserType, BrowserNavigate, BrowserScroll, etc.) automatically feeds the camera engine. You do NOT need to call recording_event — just use browser tools normally.

**When to record:** After completing a significant feature, bug fix, or PR — record a demo showing what changed and how it works. This is especially valuable for UI changes, new flows, or anything visual.

**How to use:**
1. Call recording_start with captureMethod "auto" — on macOS it uses avfoundation for smooth 30fps video (requires Screen Recording permission in System Settings). If permission is not granted, it falls back to events-only mode.
2. Use the browser tools to navigate and interact with the app as a user would — events are recorded automatically
3. Call recording_chapter to add semantic sections ("Login flow", "Dashboard view", etc.)
4. Call recording_stop to produce the final MP4

The camera engine automatically creates cinematic zoom/pan effects: 2x zoom on typing, 1.8x on clicks, 1.3x on scrolling, 1x on navigation. Output is saved as MP4. If outputPath is empty after stop, screen capture failed — check ffmpeg availability.
`;

/** The per-harness append: claude gets the recording briefing, codex does not. */
export function buildSystemPromptAppend(
  harness: "claude" | "codex-sdk" | "codex-server",
  cwd?: string
): string {
  const workspaceContext = buildWorkspaceContext(cwd) || FALLBACK_CONTEXT;
  if (harness !== "claude") return workspaceContext;
  return `${workspaceContext}\n${SCREEN_RECORDING}`.trim();
}
