// agent-server/agents/codex-server/codex-server-handler.ts
// Codex app-server harness. This is intentionally separate from the existing
// `codex` SDK/exec handler so we can expose and iterate on app-server behavior
// without changing current Codex sessions.

import { EventBroadcaster } from "../../event-broadcaster";
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
import {
  buildCodexThreadParams,
  buildCodexTurnStartParams,
  mapCodexThinkingLevel,
} from "./codex-server-config";
import {
  clearNativeGoal,
  ensureNativeGoal,
  nativeGoalOwnsTurn,
  syncNativeGoalUpdate,
} from "./codex-server-goals";
import { CodexServerTurnWatcher } from "./codex-server-turn-watcher";

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

    await clearNativeGoal(session);

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
    let turnWatcher: CodexServerTurnWatcher | undefined;

    try {
      if (!options.model) {
        throw new Error(`[codex-server-handler] options.model is required (session=${sessionId})`);
      }
      const effort = mapCodexThinkingLevel(options.thinkingLevel);

      const previousSession = codexServerSessions.get(sessionId);
      const sessionState: CodexServerSessionState = {
        threadId: previousSession?.threadId,
        turnId: previousSession?.turnId,
        appServer: previousSession?.appServer,
        abortController,
        currentModel: options.model,
        cwd: options.cwd,
        isRunning: true,
        nativeGoalKnown: previousSession?.nativeGoalKnown,
      };
      session = sessionState;
      codexServerSessions.set(sessionId, sessionState);

      const env = buildAgentEnvironment({
        providerEnvVars: options?.providerEnvVars,
        deusEnv: options?.deusEnv,
        ghToken: options?.ghToken,
      });
      const codexPath = getCodexServerExecutablePath();
      if (!codexPath) {
        throw new Error("Codex app-server executable path is required");
      }

      if (!sessionState.appServer) {
        sessionState.appServer = new CodexAppServerClient({
          codexPath,
          cwd: options.cwd,
          env,
          onRequest: (method, requestParams) =>
            this.handleAppServerRequest(sessionId, method, requestParams),
        });
        await sessionState.appServer.initialize();
      }

      const workspaceContext = buildWorkspaceContext(options.cwd);
      const threadParams = buildCodexThreadParams(options, workspaceContext);
      const shouldResume = !sessionState.threadId && !!resumeThreadId;

      if (shouldResume) {
        const response = await sessionState.appServer.request("thread/resume", {
          ...threadParams,
          threadId: resumeThreadId,
          excludeTurns: true,
        });
        sessionState.threadId = response.thread.id;
        EventBroadcaster.emitAgentSessionId(sessionId, response.thread.id);
        console.log(`[${queryId}] Resumed thread: ${response.thread.id}`);
      } else if (!sessionState.threadId) {
        const response = await sessionState.appServer.request("thread/start", threadParams);
        sessionState.threadId = response.thread.id;
        EventBroadcaster.emitAgentSessionId(sessionId, response.thread.id);
        console.log(`[${queryId}] Started thread: ${response.thread.id}`);
      }

      if (!sessionState.threadId) {
        throw new Error("Codex app-server did not return a thread id");
      }

      turnWatcher = new CodexServerTurnWatcher({
        sessionId,
        session: sessionState,
        queryOptions: options,
        abortSignal: abortController.signal,
        onNativeGoalUpdate: (goal) => syncNativeGoalUpdate(sessionId, goal),
      });

      if (options.goalContext) {
        const goal = await ensureNativeGoal(sessionState, options);
        turnWatcher.setGoalStatus(goal?.status);
      }

      if (!nativeGoalOwnsTurn(options)) {
        const turn = await sessionState.appServer.request(
          "turn/start",
          buildCodexTurnStartParams(options, {
            threadId: sessionState.threadId,
            prompt,
            effort,
          }),
          { signal: abortController.signal }
        );
        turnWatcher.markStartedTurn(turn.turn.id);
      }

      const completedTurn = await turnWatcher.completion;

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
      turnWatcher?.dispose();
      if (session && codexServerSessions.owns(sessionId, session)) {
        session.isRunning = false;
      }
    }
  }

  private async handleAppServerRequest(
    _sessionId: string,
    method: string,
    _params: unknown
  ): Promise<unknown> {
    throw new Error(`Unsupported Codex app-server request: ${method}`);
  }
}
