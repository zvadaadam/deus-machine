// backend/src/services/goals/goal-orchestrator.ts
// Backend-driven continuation loop for persisted active goals.

import {
  decideAfterTurn,
  goalContextFromGoal,
  renderGoalContinuationPrompt,
} from "@shared/goal-decision";
import type { AgentEvent, TurnStartRequest, TurnStartResponse } from "@shared/agent-events";
import type { AgentHarness } from "@shared/enums";
import { getDatabase } from "../../lib/database";
import { getSessionRaw, getWorkspaceForMiddleware } from "../../db";
import { computeWorkspacePath } from "../../middleware/workspace-loader";
import { invalidate } from "../query-engine";
import { pushGoalEnded, pushGoalUpdated } from "./goal-events";
import {
  budgetLimitGoal,
  getRunnableGoal,
  saveGoalProgress,
  toActiveGoal,
  type StoredGoal,
} from "./goal-store";

type StartTurnFn = (params: TurnStartRequest) => Promise<TurnStartResponse>;

export interface GoalOrchestratorDeps {
  startTurn: StartTurnFn;
}

export function handleGoalTurnCompleted(
  event: AgentEvent & { type: "turn.completed" },
  deps: GoalOrchestratorDeps
): void {
  const stored = getRunnableGoal(event.sessionId);
  if (!stored) return;

  const decision = decideAfterTurn(toActiveGoal(stored), { tokens: event.tokens });

  if (decision.kind === "finalize") {
    const ended = budgetLimitGoal(event.sessionId, decision.goal);
    if (ended) pushGoalEnded(ended);
    invalidate(["goal"], { sessionIds: [event.sessionId] });
    return;
  }

  const nextStored = saveGoalProgress(event.sessionId, decision.goal);
  if (!nextStored) return;

  pushGoalUpdated(toActiveGoal(nextStored));
  invalidate(["goal"], { sessionIds: [event.sessionId] });

  if (isSessionIdle(event.sessionId)) {
    void startGoalContinuation(event.sessionId, deps);
  }
}

export function handleGoalSessionIdle(sessionId: string, deps: GoalOrchestratorDeps): void {
  const goal = getRunnableGoal(sessionId);
  if (!goal) return;
  void startGoalContinuation(sessionId, deps);
}

export async function startGoalContinuation(
  sessionId: string,
  deps: GoalOrchestratorDeps
): Promise<void> {
  const request = buildGoalTurnStartRequest(sessionId);
  if (!request) return;

  try {
    const response = await deps.startTurn(request);
    if (!response.accepted) {
      console.warn(
        `[GoalOrchestrator] continuation rejected session=${sessionId}: ${response.reason ?? "unknown"}`
      );
    }
  } catch (error) {
    console.error(`[GoalOrchestrator] failed to start continuation session=${sessionId}`, error);
  }
}

export function buildGoalTurnStartRequest(sessionId: string): TurnStartRequest | null {
  const goal = getRunnableGoal(sessionId);
  if (!goal) return null;

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) return null;

  const workspace = getWorkspaceForMiddleware(db, session.workspace_id);
  if (!workspace) return null;

  const cwd = computeWorkspacePath(workspace);
  if (!cwd) return null;

  return {
    sessionId,
    agentHarness: session.agent_harness as AgentHarness,
    prompt: renderGoalContinuationPrompt(toActiveGoal(goal)),
    options: buildGoalTurnOptions(goal, cwd, session.agent_session_id),
  };
}

export function buildGoalTurnOptions(
  goal: StoredGoal,
  cwd: string,
  resume: string | null
): TurnStartRequest["options"] {
  return {
    cwd,
    model: goal.model,
    thinkingLevel: goal.thinkingLevel,
    resume: resume ?? undefined,
    goalContext: goalContextFromGoal(goal),
    allowQuestions: goal.allowQuestions,
  };
}

function isSessionIdle(sessionId: string): boolean {
  const session = getSessionRaw(getDatabase(), sessionId);
  return session?.status === "idle";
}
