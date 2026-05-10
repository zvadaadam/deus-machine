// shared/goals.ts
// Provider-neutral goal state shared by the backend orchestrator, agent-server
// adapters, and frontend status UI.

import { z } from "zod";
import { AgentHarnessSchema } from "./enums";

const GoalThinkingLevelSchema = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "XHIGH"]);

export const GoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalContextSchema = z.object({
  objective: z.string().min(1),
  tokenBudget: z.number().int().positive().nullable(),
  spentTokens: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
});
export type GoalContext = z.infer<typeof GoalContextSchema>;

export const ActiveGoalSchema = z.object({
  sessionId: z.string().min(1),
  goalId: z.string().min(1),
  objective: z.string().min(1),
  status: GoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  spentTokens: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  allowQuestions: z.boolean(),
});
export type ActiveGoal = z.infer<typeof ActiveGoalSchema>;

export const GoalEndReasonSchema = z.enum(["complete", "budget_limited", "cancelled"]);
export type GoalEndReason = z.infer<typeof GoalEndReasonSchema>;

export const EndedGoalSchema = ActiveGoalSchema.extend({
  reason: GoalEndReasonSchema,
  summary: z.string().optional(),
});
export type EndedGoal = z.infer<typeof EndedGoalSchema>;

export const GoalStartRequestSchema = z.object({
  sessionId: z.string().min(1),
  objective: z.string().min(1),
  tokenBudget: z.number().int().positive().nullable().optional(),
  model: z.string().min(1),
  agentHarness: AgentHarnessSchema,
  thinkingLevel: GoalThinkingLevelSchema.optional(),
  allowQuestions: z.boolean().optional(),
});
export type GoalStartRequest = z.infer<typeof GoalStartRequestSchema>;

export const GoalCancelRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type GoalCancelRequest = z.infer<typeof GoalCancelRequestSchema>;

export const GoalResumeRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type GoalResumeRequest = z.infer<typeof GoalResumeRequestSchema>;

export const GoalUpdateRequestSchema = z.object({
  sessionId: z.string().min(1),
  status: z.literal("complete"),
  summary: z.string().optional(),
});
export type GoalUpdateRequest = z.infer<typeof GoalUpdateRequestSchema>;
