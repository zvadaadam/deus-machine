// backend/src/services/agent/commands.ts
// Business logic for q:command dispatch.
//
// Each command handler is a focused function that:
//   1. Validates and extracts typed params
//   2. Performs DB writes
//   3. Triggers subscription invalidation
//   4. Forwards to agent-server when needed
//
// The query engine (protocol layer) delegates here — it should never
// contain business logic directly.

import { match } from "ts-pattern";
import { getDatabase } from "../../lib/database";
import { getSessionRaw, getWorkspaceForMiddleware } from "../../db";
import { computeWorkspacePath } from "../../middleware/workspace-loader";
import { writeUserMessage } from "../message-writer";
import { spawnPty, writeToPty, resizePty, killPty } from "../pty.service";
import { watchWorkspace, unwatchWorkspace } from "../fs-watcher.service";
import { delegateToRoute } from "../route-delegate";
import { persistSessionError } from "./persistence";
import { invalidate } from "../query-engine";
import * as agentService from "./service";
import { resolveAapPaths } from "./service";
import * as simulator from "../simulator-context";
import * as browserProxy from "../browser-proxy.service";
import { launchApp, stopApp } from "../aap";
import { broadcast as wsBroadcast } from "../ws.service";
import type { AgentHarness } from "@shared/enums";
import type { CommandName } from "@shared/types/query-protocol";
import type {
  BrowserProxyInputParams,
  BrowserProxyMediaTransport,
  BrowserProxyMouseButton,
} from "@shared/types/browser-proxy";
import {
  type QueryParams,
  readStringParam as readString,
  readNumberParam as readNumber,
  requireParam,
} from "../../lib/query-params";

interface CommandResult {
  commandId?: string;
  [key: string]: unknown;
}

interface CommandContext {
  connectionId?: string;
}

const MAX_BROWSER_TEXT_LENGTH = 256;
const MAX_BROWSER_KEY_LENGTH = 32;

// ---- Command Dispatch ----

export async function runCommand(
  command: CommandName,
  params: QueryParams,
  context: CommandContext = {}
): Promise<CommandResult> {
  return (
    match(command)
      .with("sendMessage", () => handleSendMessage(params))
      .with("stopSession", () => handleStopSession(params))
      // ---- PTY commands ----
      .with("pty:spawn", () => {
        const id = requireParam(params, "id", "pty:spawn");
        const cmd = readString(params, "command") ?? "bash";
        const args = Array.isArray(params.args) ? (params.args as string[]) : [];
        const cols = readNumber(params, "cols") ?? 80;
        const rows = readNumber(params, "rows") ?? 24;
        const cwd = readString(params, "cwd");

        const ptyId = spawnPty({ id, command: cmd, args, cols, rows, cwd });
        return { commandId: ptyId };
      })
      .with("pty:write", () => {
        const id = requireParam(params, "id", "pty:write");
        const data = Array.isArray(params.data) ? (params.data as number[]) : undefined;
        if (!data) throw new Error("pty:write requires data (number[])");

        writeToPty(id, data);
        return {};
      })
      .with("pty:resize", () => {
        const id = readString(params, "id");
        const cols = readNumber(params, "cols");
        const rows = readNumber(params, "rows");
        if (!id || cols === undefined || rows === undefined) {
          throw new Error("pty:resize requires id, cols, and rows");
        }

        resizePty(id, cols, rows);
        return {};
      })
      .with("pty:kill", () => {
        const id = requireParam(params, "id", "pty:kill");

        killPty(id);
        return {};
      })
      // ---- File system commands ----
      .with("fs:watch", async () => {
        const workspacePath = requireParam(params, "workspacePath", "fs:watch");

        await watchWorkspace(workspacePath);
        return {};
      })
      .with("fs:unwatch", async () => {
        const workspacePath = requireParam(params, "workspacePath", "fs:unwatch");

        await unwatchWorkspace(workspacePath);
        return {};
      })
      // ---- Git commands ----
      .with("git:clone", async () => {
        const url = readString(params, "url");
        const targetPath = readString(params, "targetPath");
        if (!url || !targetPath) throw new Error("git:clone requires url and targetPath");
        const result = (await delegateToRoute("POST", "/api/repos/clone", {
          url,
          targetPath,
        })) as { success?: boolean; path?: string; error?: string };
        if (result.error) throw new Error(result.error);
        return {};
      })
      .with("git:init", async () => {
        const projectName = readString(params, "projectName");
        const targetPath = readString(params, "targetPath");
        if (!projectName || !targetPath)
          throw new Error("git:init requires projectName and targetPath");
        const templateType = readString(params, "templateType");
        const templateUrl = readString(params, "templateUrl");
        const result = (await delegateToRoute("POST", "/api/repos/init", {
          projectName,
          targetPath,
          ...(templateType ? { template: { type: templateType, url: templateUrl } } : {}),
        })) as { success?: boolean; path?: string; githubUrl?: string; error?: string };
        if (result.error) throw new Error(result.error);
        return { githubUrl: result.githubUrl };
      })
      // ---- Route-delegated commands ----
      .with("createWorkspace", async () => {
        const repositoryId = requireParam(params, "repository_id", "createWorkspace");
        const body: Record<string, unknown> = { repository_id: repositoryId };
        const sourceBranch = readString(params, "source_branch");
        const prUrl = readString(params, "pr_url");
        const prTitle = readString(params, "pr_title");
        const targetBranch = readString(params, "target_branch");
        if (sourceBranch) body.source_branch = sourceBranch;
        if (params.pr_number != null) body.pr_number = params.pr_number;
        if (prUrl) body.pr_url = prUrl;
        if (prTitle) body.pr_title = prTitle;
        if (targetBranch) body.target_branch = targetBranch;
        const result = (await delegateToRoute("POST", "/api/workspaces", body)) as { id?: string };
        return { commandId: result.id };
      })
      .with("retrySetup", async () => {
        const workspaceId = requireParam(params, "workspaceId", "retrySetup");
        await delegateToRoute("POST", `/api/workspaces/${workspaceId}/retry-setup`);
        return {};
      })
      .with("openPenFile", async () => {
        const workspaceId = readString(params, "workspaceId");
        const filePath = readString(params, "filePath");
        if (!workspaceId || !filePath)
          throw new Error("openPenFile requires workspaceId and filePath");
        await delegateToRoute("POST", `/api/workspaces/${workspaceId}/open-pen-file`, {
          filePath,
        });
        return {};
      })
      // ---- Simulator commands ----
      .with("sim:listDevices", async () => {
        const devices = await simulator.listDevices();
        return { devices };
      })
      .with("sim:start", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:start");
        const udid = requireParam(params, "udid", "sim:start");
        const skipBootCheck = params.skipBootCheck === true;
        // Async: start returns immediately, pushes sim:streamReady event when ready
        simulator.startStream(workspaceId, udid, skipBootCheck).catch((err) => {
          console.error("[Simulator] startStream failed:", err);
          wsBroadcast(
            JSON.stringify({
              type: "q:event",
              event: "sim:streamFailed",
              data: { workspaceId, error: err instanceof Error ? err.message : String(err) },
            })
          );
        });
        return {};
      })
      .with("sim:stop", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:stop");
        simulator.stopStream(workspaceId);
        return {};
      })
      .with("sim:touch", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:touch");
        const x = readNumber(params, "x");
        const y = readNumber(params, "y");
        if (x === undefined || y === undefined) {
          throw new Error("sim:touch requires numeric x and y");
        }
        const touchType = readString(params, "touchType") ?? "began";
        simulator.sendTouch(workspaceId, x, y, touchType);
        return {};
      })
      .with("sim:key", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:key");
        const keycode = readNumber(params, "keycode");
        if (keycode === undefined) {
          throw new Error("sim:key requires a numeric keycode");
        }
        const direction = readString(params, "direction") ?? "down";
        simulator.sendKey(workspaceId, keycode, direction);
        return {};
      })
      .with("sim:scroll", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:scroll");
        const x = readNumber(params, "x");
        const y = readNumber(params, "y");
        const dx = readNumber(params, "dx");
        const dy = readNumber(params, "dy");
        if (x === undefined || y === undefined || dx === undefined || dy === undefined) {
          throw new Error("sim:scroll requires numeric x, y, dx, dy");
        }
        simulator.sendScroll(workspaceId, x, y, dx, dy);
        return {};
      })
      .with("sim:button", () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:button");
        const buttonType = readString(params, "buttonType");
        if (!buttonType) {
          throw new Error("sim:button requires buttonType");
        }
        simulator.sendButton(workspaceId, buttonType);
        return {};
      })
      .with("sim:screenshot", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:screenshot");
        const bytes = await simulator.takeScreenshot(workspaceId);
        return { bytes };
      })
      .with("sim:inspectStart", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:inspectStart");
        const bundleId = readString(params, "bundleId");
        const snapshot = await simulator.startInspector(workspaceId, bundleId ?? undefined);
        return { snapshot };
      })
      .with("sim:inspectSnapshot", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:inspectSnapshot");
        const snapshot = await simulator.inspectorSnapshot(workspaceId);
        return { snapshot };
      })
      .with("sim:buildAndRun", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:buildAndRun");
        const workspacePath = requireParam(params, "workspacePath", "sim:buildAndRun");
        const scheme = readString(params, "scheme");
        // Async: pushes sim:buildLog, sim:buildComplete or sim:buildFailed events
        simulator.buildAndRun(workspaceId, workspacePath, scheme ?? undefined).catch((err) => {
          wsBroadcast(
            JSON.stringify({
              type: "q:event",
              event: "sim:buildFailed",
              data: { workspaceId, error: err instanceof Error ? err.message : String(err) },
            })
          );
        });
        return {};
      })
      .with("sim:hasXcodeProject", async () => {
        const workspacePath = requireParam(params, "workspacePath", "sim:hasXcodeProject");
        const hasProject = await simulator.hasXcodeProject(workspacePath);
        return { hasProject };
      })
      .with("sim:launchApp", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:launchApp");
        const bundleId = requireParam(params, "bundleId", "sim:launchApp");
        const session = simulator.getContextForWorkspace(workspaceId);
        if (!session) throw new Error("No active simulator session");
        await import("child_process").then(({ execFile }) => {
          const { promisify } = require("util");
          return promisify(execFile)("xcrun", ["simctl", "launch", session.udid, bundleId]);
        });
        return {};
      })
      .with("sim:terminateApp", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:terminateApp");
        const bundleId = requireParam(params, "bundleId", "sim:terminateApp");
        const session = simulator.getContextForWorkspace(workspaceId);
        if (!session) throw new Error("No active simulator session");
        await import("child_process").then(({ execFile }) => {
          const { promisify } = require("util");
          return promisify(execFile)("xcrun", ["simctl", "terminate", session.udid, bundleId]);
        });
        return {};
      })
      .with("sim:uninstallApp", async () => {
        const workspaceId = requireParam(params, "workspaceId", "sim:uninstallApp");
        const bundleId = requireParam(params, "bundleId", "sim:uninstallApp");
        const session = simulator.getContextForWorkspace(workspaceId);
        if (!session) throw new Error("No active simulator session");
        await import("child_process").then(({ execFile }) => {
          const { promisify } = require("util");
          return promisify(execFile)("xcrun", ["simctl", "uninstall", session.udid, bundleId]);
        });
        return {};
      })
      // ---- AAP (agentic apps protocol) commands ----
      .with("launchApp", () => handleLaunchApp(params))
      .with("stopApp", () => handleStopApp(params))
      // ---- Remote browser proxy commands ----
      .with("browser:attach", async () => {
        const tabId = requireParam(params, "tabId", "browser:attach");
        const width = readNumber(params, "width");
        const height = readNumber(params, "height");
        if (width === undefined || height === undefined) {
          throw new Error("browser:attach requires numeric width and height");
        }
        await browserProxy.attachBrowserTab(
          {
            tabId,
            workspaceId: readString(params, "workspaceId"),
            width,
            height,
            url: readString(params, "url"),
            isMobileView: params.isMobileView === true,
            mediaTransport: readBrowserMediaTransport(params),
          },
          context.connectionId
        );
        return {};
      })
      .with("browser:registerNativeTab", () => {
        const tabId = requireParam(params, "tabId", "browser:registerNativeTab");
        const workspaceId = requireParam(params, "workspaceId", "browser:registerNativeTab");
        browserProxy.registerNativeBrowserTab({
          tabId,
          workspaceId,
          url: readString(params, "url"),
        });
        return {};
      })
      .with("browser:unregisterNativeTab", () => {
        browserProxy.unregisterNativeBrowserTab({
          tabId: requireParam(params, "tabId", "browser:unregisterNativeTab"),
        });
        return {};
      })
      .with("browser:detach", async () => {
        await browserProxy.detachBrowserTab(
          {
            tabId: requireParam(params, "tabId", "browser:detach"),
          },
          context.connectionId
        );
        return {};
      })
      .with("browser:close", async () => {
        await browserProxy.closeBrowserTab({
          tabId: requireParam(params, "tabId", "browser:close"),
        });
        return {};
      })
      .with("browser:navigate", async () => {
        const tabId = requireParam(params, "tabId", "browser:navigate");
        const url = requireParam(params, "url", "browser:navigate");
        await browserProxy.navigateBrowserTab({ tabId, url });
        return {};
      })
      .with("browser:back", async () => {
        await browserProxy.goBackBrowserTab({
          tabId: requireParam(params, "tabId", "browser:back"),
        });
        return {};
      })
      .with("browser:forward", async () => {
        await browserProxy.goForwardBrowserTab({
          tabId: requireParam(params, "tabId", "browser:forward"),
        });
        return {};
      })
      .with("browser:reload", async () => {
        await browserProxy.reloadBrowserTab({
          tabId: requireParam(params, "tabId", "browser:reload"),
        });
        return {};
      })
      .with("browser:resize", async () => {
        const tabId = requireParam(params, "tabId", "browser:resize");
        const width = readNumber(params, "width");
        const height = readNumber(params, "height");
        if (width === undefined || height === undefined) {
          throw new Error("browser:resize requires numeric width and height");
        }
        await browserProxy.resizeBrowserTab({
          tabId,
          width,
          height,
          isMobileView: params.isMobileView === true,
          mediaTransport: readBrowserMediaTransport(params),
        });
        return {};
      })
      .with("browser:input", async () => {
        await browserProxy.sendBrowserInput(parseBrowserInput(params));
        return {};
      })
      .with("browser:eval", async () => {
        const result = await browserProxy.evaluateBrowserTab({
          tabId: requireParam(params, "tabId", "browser:eval"),
          expression: requireParam(params, "expression", "browser:eval"),
        });
        return { result };
      })
      .with("browser:captureScreenshot", async () => {
        const dataUrl = await browserProxy.captureBrowserScreenshot({
          tabId: requireParam(params, "tabId", "browser:captureScreenshot"),
          rect: parseScreenshotRect(params.rect),
        });
        return { dataUrl };
      })
      .exhaustive()
  );
}

// ---- sendMessage ----

function handleSendMessage(params: QueryParams): CommandResult {
  const sessionId = requireParam(params, "sessionId", "sendMessage");
  const content = requireParam(params, "content", "sendMessage");
  const model = requireParam(params, "model", "sendMessage");
  const agentHarness = requireParam(params, "agentHarness", "sendMessage") as AgentHarness;

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);

  // Harness lock: once a session has messages, its agent harness is bound to
  // a specific SDK process. Reject cross-harness switches to keep the server
  // authoritative; the UI disables these options too, but this is the source
  // of truth.
  if (session && session.message_count > 0 && session.agent_harness !== agentHarness) {
    throw new Error(
      `Cannot switch agent from ${session.agent_harness} to ${agentHarness} on a session with messages. Open a new chat tab instead.`
    );
  }

  // New sessions default to Claude at creation time because the user may pick
  // the actual harness in the composer before the first send. Persist that
  // first-send choice so follow-up turns route to the same agent process.
  if (session && session.message_count === 0 && session.agent_harness !== agentHarness) {
    const result = db
      .prepare(
        `
        UPDATE sessions
        SET agent_harness = ?, updated_at = datetime('now')
        WHERE id = ? AND message_count = 0
      `
      )
      .run(agentHarness, sessionId);

    if (result.changes === 0) {
      const current = getSessionRaw(db, sessionId);
      if (current && current.agent_harness !== agentHarness) {
        throw new Error(
          `Cannot switch agent from ${current.agent_harness} to ${agentHarness} on a session with messages. Open a new chat tab instead.`
        );
      }
    }
  }

  // 1. Persist the user message
  const result = writeUserMessage(sessionId, content, model);
  if (!result.success) throw new Error(result.error);
  invalidate(["workspaces", "sessions", "session", "messages", "stats"], {
    sessionIds: [sessionId],
  });

  // 2. Forward to agent-server (fire-and-forget — ACK already sent)
  const existingAgentSessionId = session?.agent_session_id ?? null;

  // Resolve cwd server-side from session → workspace → repo.
  // Clear any caller-provided value so the server is authoritative.
  delete params.cwd;
  if (session) {
    const workspace = getWorkspaceForMiddleware(db, session.workspace_id);
    if (workspace) {
      params.cwd = computeWorkspacePath(workspace);
    }
  }

  if (!agentService.isConnected()) {
    handleAgentError(sessionId, agentHarness, new Error("Agent server is disconnected"));
    return { commandId: result.messageId };
  }

  agentService
    .forwardTurn({
      sessionId,
      agentHarness,
      prompt: content,
      options: buildTurnOptions(params, model, existingAgentSessionId) as Parameters<
        typeof agentService.forwardTurn
      >[0]["options"],
    })
    .then((response) => {
      if (!response.accepted) {
        handleAgentRejection(sessionId, agentHarness, response.reason);
      }
    })
    .catch((err) => {
      handleAgentError(sessionId, agentHarness, err);
    });

  return { commandId: result.messageId };
}

// ---- stopSession ----

async function handleStopSession(params: QueryParams): Promise<CommandResult> {
  const sessionId = requireParam(params, "sessionId", "stopSession");

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new Error("Session not found");

  if (agentService.isConnected()) {
    try {
      await agentService.stopSession({ sessionId });
    } catch (err) {
      console.error("[CommandHandler] Failed to stop on agent-server:", err);
      // Still mark idle locally — best effort
    }
  }

  db.prepare("UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(
    sessionId
  );
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
  return {};
}

// ---- AAP (agentic apps protocol) ----

/**
 * User-initiated launch from the Apps tab. Resolves workspaceId → workspacePath
 * the same way the Phase 3 agent-server RPC bridge does (service.ts
 * handleAapRpc) so both paths converge on identical inputs to apps.service.
 *
 * Returns the full LaunchAppResult so the q:command_ack carries runningAppId +
 * url + bootstrap for any caller that wants to react before the apps:launched
 * q:event arrives. The frontend's primary path is the event (it listens for
 * all launches, including agent-initiated ones) — this return value is just
 * belt-and-suspenders for the sync command-response path.
 */
async function handleLaunchApp(params: QueryParams): Promise<CommandResult> {
  const appId = requireParam(params, "appId", "launchApp");
  const workspaceId = requireParam(params, "workspaceId", "launchApp");

  // Shared with the agent RPC path — both converge on identical inputs to
  // apps.service.launchApp. Throws on missing workspace / unresolvable path.
  const { workspacePath, userDataDir } = resolveAapPaths({ workspaceId });

  const result = await launchApp({ appId, workspaceId, workspacePath, userDataDir });
  return { ...result };
}

async function handleStopApp(params: QueryParams): Promise<CommandResult> {
  const runningAppId = requireParam(params, "runningAppId", "stopApp");
  await stopApp(runningAppId);
  return { success: true };
}

// ---- Helpers ----

function buildTurnOptions(
  params: QueryParams,
  model: string | undefined,
  resume: string | null
): Record<string, unknown> {
  return {
    cwd: readString(params, "cwd") || "",
    model,
    thinkingLevel: readString(params, "thinkingLevel"),
    maxTurns: params.maxTurns as number | undefined,
    turnId: readString(params, "turnId"),
    permissionMode: readString(params, "permissionMode"),
    providerEnvVars: readString(params, "providerEnvVars"),
    ghToken: readString(params, "ghToken"),
    deusEnv: params.deusEnv as Record<string, string> | undefined,
    additionalDirectories: params.additionalDirectories as string[] | undefined,
    chromeEnabled: params.chromeEnabled as boolean | undefined,
    strictDataPrivacy: params.strictDataPrivacy as boolean | undefined,
    shouldResetGenerator: params.shouldResetGenerator as boolean | undefined,
    resume: resume || readString(params, "resume"),
    resumeSessionAt: readString(params, "resumeSessionAt"),
  };
}

function handleAgentRejection(sessionId: string, agentHarness: string, reason?: string): void {
  const msg = reason || "Agent rejected the message";
  console.error(`[CommandHandler] Agent rejected sendMessage for session=${sessionId}: ${msg}`);
  persistSessionError({
    type: "session.error",
    sessionId,
    agentHarness: agentHarness as AgentHarness,
    error: msg,
    category: "internal",
  });
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
}

function handleAgentError(sessionId: string, agentHarness: string, err: unknown): void {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error("[CommandHandler] Failed to forward to agent-server:", errorMsg);
  persistSessionError({
    type: "session.error",
    sessionId,
    agentHarness: agentHarness as AgentHarness,
    error: `Agent server communication failed: ${errorMsg}`,
    category: "internal",
  });
  invalidate(["workspaces", "sessions", "session", "stats"], { sessionIds: [sessionId] });
}

function parseBrowserInput(params: QueryParams): BrowserProxyInputParams {
  const tabId = requireParam(params, "tabId", "browser:input");
  const kind = readString(params, "kind");
  const modifiers = readNumber(params, "modifiers") ?? 0;

  if (kind === "mouse") {
    const type = readString(params, "inputType");
    const x = readNumber(params, "x");
    const y = readNumber(params, "y");
    const button = readString(params, "button") ?? "none";
    if (
      (type !== "mousePressed" && type !== "mouseReleased" && type !== "mouseMoved") ||
      x === undefined ||
      y === undefined ||
      !isMouseButton(button)
    ) {
      throw new Error("browser:input mouse requires inputType, x, y, and button");
    }
    return {
      tabId,
      kind,
      type,
      x,
      y,
      button,
      clickCount: readNumber(params, "clickCount") ?? 0,
      modifiers,
    };
  }

  if (kind === "wheel") {
    const x = readNumber(params, "x");
    const y = readNumber(params, "y");
    const deltaX = readNumber(params, "deltaX");
    const deltaY = readNumber(params, "deltaY");
    if (x === undefined || y === undefined || deltaX === undefined || deltaY === undefined) {
      throw new Error("browser:input wheel requires x, y, deltaX, and deltaY");
    }
    return { tabId, kind, x, y, deltaX, deltaY, modifiers };
  }

  if (kind === "key") {
    const type = readString(params, "inputType");
    const key = readString(params, "key");
    const code = readString(params, "code");
    if ((type !== "keyDown" && type !== "keyUp") || !key || !code) {
      throw new Error("browser:input key requires inputType, key, and code");
    }
    if (key.length > MAX_BROWSER_KEY_LENGTH || code.length > MAX_BROWSER_KEY_LENGTH) {
      throw new Error("browser:input key and code are too long");
    }
    const text = readString(params, "text");
    if (text && text.length > MAX_BROWSER_TEXT_LENGTH) {
      throw new Error("browser:input text is too long");
    }
    return {
      tabId,
      kind,
      type,
      key,
      code,
      text,
      modifiers,
    };
  }

  if (kind === "touch") {
    const type = readString(params, "inputType");
    const rawPoints = Array.isArray(params.touchPoints) ? params.touchPoints : undefined;
    if (
      (type !== "touchStart" &&
        type !== "touchMove" &&
        type !== "touchEnd" &&
        type !== "touchCancel") ||
      !rawPoints
    ) {
      throw new Error("browser:input touch requires inputType and touchPoints");
    }
    const touchPoints = rawPoints.slice(0, 5).map((point) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) {
        throw new Error("browser:input touchPoints must be objects");
      }
      const record = point as Record<string, unknown>;
      const x = typeof record.x === "number" && Number.isFinite(record.x) ? record.x : undefined;
      const y = typeof record.y === "number" && Number.isFinite(record.y) ? record.y : undefined;
      const id =
        typeof record.id === "number" && Number.isFinite(record.id) ? record.id : undefined;
      if (x === undefined || y === undefined) {
        throw new Error("browser:input touchPoints require numeric x and y");
      }
      return { x, y, ...(id !== undefined ? { id } : {}) };
    });
    return { tabId, kind, type, touchPoints, modifiers };
  }

  throw new Error("browser:input requires kind");
}

function isMouseButton(value: string): value is BrowserProxyMouseButton {
  return value === "none" || value === "left" || value === "middle" || value === "right";
}

function readBrowserMediaTransport(params: QueryParams): BrowserProxyMediaTransport | undefined {
  const transport = readString(params, "mediaTransport");
  if (!transport) return undefined;
  if (transport === "websocket-frames") return transport;
  throw new Error("browser mediaTransport must be websocket-frames");
}

function parseScreenshotRect(
  value: unknown
): { x: number; y: number; width: number; height: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rect = value as Record<string, unknown>;
  const x = typeof rect.x === "number" ? rect.x : undefined;
  const y = typeof rect.y === "number" ? rect.y : undefined;
  const width = typeof rect.width === "number" ? rect.width : undefined;
  const height = typeof rect.height === "number" ? rect.height : undefined;
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new Error("browser:captureScreenshot rect requires numeric x, y, width, height");
  }
  return { x, y, width, height };
}
