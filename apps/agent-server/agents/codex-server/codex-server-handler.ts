// agent-server/agents/codex-server/codex-server-handler.ts
// Codex app-server harness. This is intentionally separate from the existing
// `codex` SDK/exec handler so we can expose and iterate on app-server behavior
// without changing current Codex sessions.

import { uuidv7 } from "@shared/lib/uuid";
import type { PartEvent } from "@shared/agent-events";
import type { Part } from "@shared/messages";
import { EventBroadcaster } from "../../event-broadcaster";
import { codexAppServerAdapter } from "../../messages/codex-app-server-adapter";
import { classifyError, handleCancellation, handleQueryError } from "../lifecycle";
import type { AgentCapabilities, AgentHandler, QueryOptions } from "../registry";
import { buildAgentEnvironment, buildWorkspaceContext } from "../environment";
import {
  blockIfCodexServerNotInitialized,
  getCodexServerExecutablePath,
  initializeCodexServer,
} from "./codex-server-discovery";
import { CodexAppServerClient } from "./codex-server-client";
import {
  abortCodexServerSession,
  closeCodexServerSession,
  codexServerSessions,
  type CodexServerSessionState,
} from "./codex-server-session";
import type {
  CodexAppServerNotification,
  CodexReasoningEffort,
  CodexSandboxPolicy,
  CodexTurn,
  CodexThreadStartParams,
} from "./codex-server-types";
import { parseThinkingLevel } from "../thinking-levels";

type CodexServerTurnCompletion = {
  status: CodexTurn["status"];
  error?: string;
};

export class CodexServerAgentHandler implements AgentHandler {
  readonly agentHarness = "codex-server" as const;
  readonly capabilities: AgentCapabilities = {
    auth: false,
    workspaceInit: false,
    contextUsage: false,
    permissionMode: false,
    modelSwitch: "in-session",
    multiTurn: true,
    sessionResume: true,
  };

  initialize(): { success: boolean; error?: string } {
    return initializeCodexServer();
  }

  async query(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    console.log("Handling Codex app-server query request for session:", sessionId);
    if (blockIfCodexServerNotInitialized(sessionId)) return;

    const existingSession = codexServerSessions.get(sessionId);
    if (existingSession?.isRunning) {
      console.log(`Codex app-server session ${sessionId} already running, interrupting prior turn`);
      await this.cancel(sessionId);
    }

    void this.processQuery(sessionId, prompt, options, options.resume);
  }

  async cancel(sessionId: string): Promise<void> {
    console.log("Handling Codex app-server cancel request for session:", sessionId);
    if (blockIfCodexServerNotInitialized(sessionId)) return;

    const session = codexServerSessions.get(sessionId);
    if (!session) return;

    session.cancelledByUser = true;
    session.abortController?.abort();

    if (session.appServer && session.threadId && session.turnId) {
      try {
        await session.appServer.request("turn/interrupt", {
          threadId: session.threadId,
          turnId: session.turnId,
        });
      } catch (error) {
        console.warn("[codex-server] Failed to interrupt Codex app-server turn:", error);
      }
    }
  }

  reset(sessionId: string): void {
    console.log(`Handling reset request for Codex app-server session: ${sessionId}`);
    abortCodexServerSession(sessionId);
    closeCodexServerSession(sessionId);
  }

  private async processQuery(
    sessionId: string,
    prompt: string,
    options: QueryOptions,
    resumeThreadId?: string
  ): Promise<void> {
    const queryId = `${sessionId}/${Date.now()}/codex-server`;
    const abortController = new AbortController();
    let session: CodexServerSessionState | undefined;

    let unsubscribe: (() => void) | undefined;

    try {
      if (!options.model) {
        throw new Error(`[codex-server-handler] options.model is required (session=${sessionId})`);
      }
      const effort = mapThinkingLevel(options.thinkingLevel);

      const previousSession = codexServerSessions.get(sessionId);
      session = {
        threadId: previousSession?.threadId,
        turnId: previousSession?.turnId,
        appServer: previousSession?.appServer,
        abortController,
        currentModel: options.model,
        cwd: options.cwd,
        isRunning: true,
      };
      codexServerSessions.set(sessionId, session);

      const env = buildAgentEnvironment({
        providerEnvVars: options?.providerEnvVars,
        deusEnv: options?.deusEnv,
        ghToken: options?.ghToken,
      });
      const codexPath = getCodexServerExecutablePath() || "codex";

      if (!session.appServer) {
        session.appServer = new CodexAppServerClient({
          codexPath,
          cwd: options.cwd,
          env,
        });
        await session.appServer.initialize();
      }

      const workspaceContext = buildWorkspaceContext(options.cwd);
      const threadParams = this.buildThreadParams(options, workspaceContext);
      const shouldResume = !session.threadId && !!resumeThreadId;

      if (shouldResume) {
        const response = await session.appServer.request("thread/resume", {
          ...threadParams,
          threadId: resumeThreadId,
          excludeTurns: true,
        });
        session.threadId = response.thread.id;
        console.log(`[${queryId}] Resumed thread: ${response.thread.id}`);
      } else if (!session.threadId) {
        const response = await session.appServer.request("thread/start", threadParams);
        session.threadId = response.thread.id;
        EventBroadcaster.emitAgentSessionId(sessionId, response.thread.id);
        console.log(`[${queryId}] Started thread: ${response.thread.id}`);
      }

      if (!session.threadId) {
        throw new Error("Codex app-server did not return a thread id");
      }

      const messageId = uuidv7();
      const transformer = codexAppServerAdapter.createTransformer({
        sessionId,
        messageId,
        turnId: options.turnId,
      });

      let currentMessageId = messageId;
      const emitEvents = (events: ReturnType<typeof transformer.process>) => {
        for (const evt of events) {
          const eventMessageId =
            messageIdForPartEvent(evt, transformer.getParts()) ?? currentMessageId;
          currentMessageId = eventMessageId;
          EventBroadcaster.emitPartEvent(sessionId, "codex-server", eventMessageId, evt);
        }
      };

      let activeTurnId: string | undefined;
      const turnCompletion = new Promise<CodexServerTurnCompletion>((resolve, reject) => {
        const abortHandler = () => reject(new Error("Codex app-server turn aborted"));
        abortController.signal.addEventListener("abort", abortHandler, { once: true });

        unsubscribe = session.appServer!.onNotification((notification) => {
          const threadId = getNotificationThreadId(notification);
          const belongsToRootThread = notificationBelongsToThread(notification, session.threadId);
          const belongsToKnownSubagent =
            !!threadId && transformer.isKnownSubagentThread?.(threadId) === true;

          if (!belongsToRootThread && !belongsToKnownSubagent) return;

          if (notification.method === "turn/started" && belongsToRootThread) {
            activeTurnId = notification.params.turn.id;
            session.turnId = activeTurnId;
          }

          if (belongsToRootThread && !notificationBelongsToTurn(notification, activeTurnId)) return;

          emitEvents(transformer.process(notification));

          if (notification.method === "turn/completed" && belongsToRootThread) {
            activeTurnId = notification.params.turn.id;
            session.turnId = activeTurnId;
            abortController.signal.removeEventListener("abort", abortHandler);
            resolve({
              status: notification.params.turn.status,
              error: notification.params.turn.error?.message,
            });
          } else if (notification.method === "error" && belongsToRootThread) {
            abortController.signal.removeEventListener("abort", abortHandler);
            reject(new Error(notification.params.error.message));
          }
        });
      });

      const turn = await session.appServer.request(
        "turn/start",
        {
          threadId: session.threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          cwd: options.cwd,
          approvalPolicy: "never",
          sandboxPolicy: buildWorkspaceWriteSandbox(options),
          model: options.model,
          effort,
          summary: "auto",
        },
        { signal: abortController.signal }
      );

      activeTurnId = activeTurnId ?? turn.turn.id;
      session.turnId = activeTurnId;

      const completedTurn = await turnCompletion;

      const finished = transformer.finish();
      emitEvents(finished.events);

      if (completedTurn.status === "interrupted") {
        handleCancellation(sessionId, "codex-server", true);
        return;
      }

      if (completedTurn.status !== "completed") {
        handleQueryError(
          sessionId,
          "codex-server",
          new Error(
            completedTurn.error ?? `Codex app-server turn ${completedTurn.status ?? "failed"}`
          )
        );
        return;
      }

      EventBroadcaster.emitSessionIdle(sessionId, "codex-server");
      console.log(`[${queryId}] Codex app-server turn completed: ${sessionId}`);
    } catch (error) {
      const raw = classifyError(error);
      const isAbort =
        raw.category === "abort" ||
        abortController.signal.aborted ||
        (error instanceof Error && error.message.includes("turn aborted"));

      console.error(
        `[${queryId}] Error in Codex app-server query [${isAbort ? "abort" : raw.category}]:`,
        raw.message
      );

      if (!session || codexServerSessions.owns(sessionId, session)) {
        if (isAbort) {
          handleCancellation(sessionId, "codex-server", session?.cancelledByUser ?? true);
        } else {
          handleQueryError(sessionId, "codex-server", error);
        }
      }
    } finally {
      unsubscribe?.();
      if (session && codexServerSessions.owns(sessionId, session)) {
        session.isRunning = false;
      }
    }
  }

  private buildThreadParams(
    options: QueryOptions,
    workspaceContext: string
  ): CodexThreadStartParams {
    return {
      model: options.model ?? null,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions: workspaceContext || null,
      config: {
        "features.collaboration_modes": true,
      },
    };
  }
}

function buildWorkspaceWriteSandbox(options: QueryOptions): CodexSandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [options.cwd, ...(options.additionalDirectories ?? [])],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function mapThinkingLevel(level: QueryOptions["thinkingLevel"]): CodexReasoningEffort | null {
  const parsed = parseThinkingLevel(level, "Codex");
  switch (parsed) {
    case "NONE":
      return "none";
    case "LOW":
      return "low";
    case "MEDIUM":
      return "medium";
    case "HIGH":
      return "high";
    case "XHIGH":
      return "xhigh";
    default:
      return null;
  }
}

function notificationBelongsToThread(
  notification: CodexAppServerNotification,
  threadId: string | undefined
): boolean {
  if (!threadId) return true;
  const notificationThreadId = getNotificationThreadId(notification);
  if (!notificationThreadId) return true;
  return notificationThreadId === threadId;
}

function getNotificationThreadId(notification: CodexAppServerNotification): string | undefined {
  const params = notification.params;
  if (!params || typeof params !== "object" || !("threadId" in params)) return undefined;
  const threadId = (params as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}

function messageIdForPartEvent(event: PartEvent, parts: Part[]): string | undefined {
  switch (event.type) {
    case "message.created":
    case "message.done":
      return event.messageId;
    case "part.created":
    case "part.done":
      return event.part.messageId;
    case "part.delta":
      return parts.find((part) => part.id === event.partId)?.messageId;
    default:
      return undefined;
  }
}

function notificationBelongsToTurn(
  notification: CodexAppServerNotification,
  turnId: string | undefined
): boolean {
  if (!turnId) return true;
  if (notification.method === "turn/started" || notification.method === "turn/completed") {
    return notification.params.turn.id === turnId;
  }
  const params = notification.params;
  if (!params || typeof params !== "object" || !("turnId" in params)) return true;
  return (params as { turnId?: string }).turnId === turnId;
}
