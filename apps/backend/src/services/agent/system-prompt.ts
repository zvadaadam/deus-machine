// backend/src/services/agent/system-prompt.ts
// The deus system-prompt append, fed to the embedded engine as
// RunConfig.systemPromptAppend: workspace context and the screen-recording
// tool briefing. Every harness has the deus tools (Claude in process, Codex
// over loopback HTTP), so every harness gets the same append.

import {
  AGENT_MESSAGES,
  buildWorkspaceContext,
  type Simulator,
  type WorkspaceSetup,
} from "./workspace-context";

const FALLBACK_CONTEXT =
  "You are working inside Deus, a desktop app that orchestrates multiple AI coding agents in parallel.";

const SCREEN_RECORDING = `
# Screen Recording

You have screen recording tools available directly — just call them, do NOT search for them with ToolSearch: recording_start, recording_chapter, recording_focus, recording_hold, recording_status, recording_stop.

**When to record:** after completing a feature, bug fix, or PR with something visible, record a short walkthrough of the result. Record the deliberate demo, not the investigation.

**How:**
1. Open the page (BrowserNavigate) or app first, then call recording_start (target "simulator" for the iOS Simulator).
2. Use the browser tools or agent-device normally. Every action is captured automatically; you never report coordinates.
3. Call recording_chapter at the start of each step ("Sign in", "Create a project").
4. Results that appear after an action are found and framed automatically. Use recording_focus (with an element ref) only to point at something specific the video should show.
5. Call recording_stop. Waiting time is sped up or cut, each action is framed, and your chapters carry over. Use preset "demo" for the shortest cut.

The recording stops itself after maxDurationSeconds (default 300). If recording_stop reports a failure, its hint says what to fix.
`;

export function buildSystemPromptAppend(
  agentMessages: boolean,
  cwd?: string,
  simulator?: Simulator | null,
  setup?: WorkspaceSetup | null
): string {
  const workspaceContext = buildWorkspaceContext(cwd, simulator, setup) || FALLBACK_CONTEXT;
  return `${workspaceContext}\n${agentMessages ? AGENT_MESSAGES : ""}${SCREEN_RECORDING}`.trim();
}
