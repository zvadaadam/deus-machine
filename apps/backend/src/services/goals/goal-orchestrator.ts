// backend/src/services/goals/goal-orchestrator.ts
// Codex-native goal coordination for persisted UI state.

import { goalContextFromGoal, tokenCountForUsage } from "@shared/goal-decision";
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
  _deps: GoalOrchestratorDeps
): void {
  const stored = getRunnableGoal(event.sessionId);
  if (!stored) return;

  const updatedGoal = {
    ...toActiveGoal(stored),
    spentTokens: stored.spentTokens + tokenCountForUsage(event.tokens),
    updatedAt: Math.floor(Date.now() / 1000),
  };

  if (updatedGoal.tokenBudget !== null && updatedGoal.spentTokens >= updatedGoal.tokenBudget) {
    const ended = budgetLimitGoal(event.sessionId, updatedGoal);
    if (ended) pushGoalEnded(ended);
    invalidate(["goal"], { sessionIds: [event.sessionId] });
    return;
  }

  const nextStored = saveGoalProgress(event.sessionId, updatedGoal);
  if (!nextStored) return;

  pushGoalUpdated(toActiveGoal(nextStored));
  invalidate(["goal"], { sessionIds: [event.sessionId] });
}

export function handleGoalSessionIdle(_sessionId: string, _deps: GoalOrchestratorDeps): void {
  // Codex app-server owns the autonomous continuation loop for active goals.
}

export async function startGoalContinuation(
  sessionId: string,
  deps: GoalOrchestratorDeps
): Promise<boolean> {
  const request = buildGoalTurnStartRequest(sessionId);
  if (!request) return false;

  try {
    const response = await deps.startTurn(request);
    if (!response.accepted) {
      console.warn(
        `[GoalOrchestrator] continuation rejected session=${sessionId}: ${response.reason ?? "unknown"}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[GoalOrchestrator] failed to start continuation session=${sessionId}`, error);
    return false;
  }
}

export function buildGoalTurnStartRequest(sessionId: string): TurnStartRequest | null {
  const goal = getRunnableGoal(sessionId);
  if (!goal) return null;

  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) return null;
  if (session.agent_harness !== "codex-server") return null;

  const workspace = getWorkspaceForMiddleware(db, session.workspace_id);
  if (!workspace) return null;

  const cwd = computeWorkspacePath(workspace);
  if (!cwd) return null;

  return {
    sessionId,
    agentHarness: session.agent_harness as AgentHarness,
    prompt: "Continue the active Codex goal.",
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
    goalAction: "continue",
  };
}
