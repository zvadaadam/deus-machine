// agent-server/agents/codex-server/codex-server-turn-watcher.ts
// Translates Codex app-server notifications for one Deus turn into canonical
// part events and a single completion result.

import { uuidv7 } from "@shared/lib/uuid";
import { codexAppServerAdapter } from "../../messages/codex-app-server-adapter";
import { createPartEventEmitter } from "../part-event-emitter";
import type { QueryOptions } from "../registry";
import type { CodexServerSessionState } from "./codex-server-session";
import type { CodexAppServerNotification, CodexThreadGoal, CodexTurn } from "./codex-server-types";
import { isTerminalGoalStatus } from "./codex-server-goals";

export type CodexServerTurnCompletion = {
  status: CodexTurn["status"];
  error?: string;
};

interface CodexServerTurnWatcherOptions {
  sessionId: string;
  session: CodexServerSessionState;
  queryOptions: QueryOptions;
  abortSignal: AbortSignal;
  onNativeGoalUpdate: (goal: CodexThreadGoal) => void | Promise<void>;
}

export class CodexServerTurnWatcher {
  readonly completion: Promise<CodexServerTurnCompletion>;

  private readonly sessionId: string;
  private readonly session: CodexServerSessionState;
  private readonly queryOptions: QueryOptions;
  private readonly abortSignal: AbortSignal;
  private readonly onNativeGoalUpdate: (goal: CodexThreadGoal) => void | Promise<void>;
  private readonly abortHandler: () => void;
  private readonly unsubscribe: () => void;
  private readonly resolveCompletion: (completion: CodexServerTurnCompletion) => void;
  private readonly rejectCompletion: (error: Error) => void;

  private activeTurnId: string | undefined;
  private rootTurnCount = 0;
  private rootGoalStatus: CodexThreadGoal["status"] | undefined;
  private transformer: ReturnType<typeof codexAppServerAdapter.createTransformer> | undefined;
  private partEmitter: ReturnType<typeof createPartEventEmitter> | undefined;
  private settled = false;

  constructor(options: CodexServerTurnWatcherOptions) {
    this.sessionId = options.sessionId;
    this.session = options.session;
    this.queryOptions = options.queryOptions;
    this.abortSignal = options.abortSignal;
    this.onNativeGoalUpdate = options.onNativeGoalUpdate;

    let resolveCompletion!: (completion: CodexServerTurnCompletion) => void;
    let rejectCompletion!: (error: Error) => void;
    this.completion = new Promise<CodexServerTurnCompletion>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.resolveCompletion = resolveCompletion;
    this.rejectCompletion = rejectCompletion;

    this.abortHandler = () => this.reject(new Error("Codex app-server turn aborted"));
    this.abortSignal.addEventListener("abort", this.abortHandler, { once: true });

    if (!this.session.appServer) {
      throw new Error("Cannot watch Codex app-server notifications before app-server exists");
    }
    this.unsubscribe = this.session.appServer.onNotification((notification) =>
      this.handleNotification(notification)
    );
  }

  dispose(): void {
    this.abortSignal.removeEventListener("abort", this.abortHandler);
    this.unsubscribe();
  }

  markStartedTurn(turnId: string): void {
    if (!this.activeTurnId) {
      this.activeTurnId = turnId;
    }
    this.session.turnId = this.activeTurnId;
  }

  setGoalStatus(status: CodexThreadGoal["status"] | undefined): void {
    if (!status) return;
    this.rootGoalStatus = status;
    this.resolveIfTerminalGoalIdle();
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    if (this.settled) return;

    const threadId = getNotificationThreadId(notification);
    const belongsToRootThread = notificationBelongsToThread(notification, this.session.threadId);
    const belongsToKnownSubagent =
      !!threadId && this.transformer?.isKnownSubagentThread?.(threadId) === true;

    if (!belongsToRootThread && !belongsToKnownSubagent) return;

    if (notification.method === "thread/goal/updated" && belongsToRootThread) {
      this.rootGoalStatus = notification.params.goal.status;
      void this.onNativeGoalUpdate(notification.params.goal);
      this.resolveIfTerminalGoalIdle();
      return;
    }

    if (notification.method === "thread/goal/cleared" && belongsToRootThread) {
      this.rootGoalStatus = "complete";
      this.resolveIfTerminalGoalIdle();
      return;
    }

    if (notification.method === "turn/started" && belongsToRootThread) {
      this.activeTurnId = notification.params.turn.id;
      this.session.turnId = this.activeTurnId;
      this.startStreamForTurn(this.activeTurnId);
    }

    if (belongsToRootThread && !notificationBelongsToTurn(notification, this.activeTurnId)) return;

    if (this.transformer && this.partEmitter) {
      this.partEmitter.emitMany(this.transformer.process(notification));
    }

    if (notification.method === "turn/completed" && belongsToRootThread) {
      this.handleTurnCompleted(notification.params.turn);
      return;
    }

    if (notification.method === "error" && belongsToRootThread) {
      this.reject(new Error(notification.params.error.message));
    }
  }

  private startStreamForTurn(turnId: string | undefined): void {
    const messageId = uuidv7();
    this.rootTurnCount += 1;
    this.transformer = codexAppServerAdapter.createTransformer({
      sessionId: this.sessionId,
      messageId,
      turnId: this.rootTurnCount === 1 ? this.queryOptions.turnId : turnId,
    });
    this.partEmitter = createPartEventEmitter({
      sessionId: this.sessionId,
      agentHarness: "codex-server",
      fallbackMessageId: messageId,
      getParts: () => this.transformer?.getParts() ?? [],
    });
  }

  private finishCurrentStream(): void {
    if (!this.transformer || !this.partEmitter) return;
    const finished = this.transformer.finish();
    this.partEmitter.emitMany(finished.events);
  }

  private handleTurnCompleted(turn: CodexTurn): void {
    const completion: CodexServerTurnCompletion = {
      status: turn.status,
      error: turn.error?.message,
    };

    this.finishCurrentStream();
    this.activeTurnId = undefined;
    this.session.turnId = undefined;

    if (
      completion.status !== "completed" ||
      !this.queryOptions.goalContext ||
      isTerminalGoalStatus(this.rootGoalStatus)
    ) {
      this.resolve(completion);
    }
  }

  private resolveIfTerminalGoalIdle(): void {
    if (!this.activeTurnId && isTerminalGoalStatus(this.rootGoalStatus)) {
      this.resolve({ status: "completed" });
    }
  }

  private resolve(completion: CodexServerTurnCompletion): void {
    if (this.settled) return;
    this.settled = true;
    this.abortSignal.removeEventListener("abort", this.abortHandler);
    this.resolveCompletion(completion);
  }

  private reject(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.abortSignal.removeEventListener("abort", this.abortHandler);
    this.rejectCompletion(error);
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
