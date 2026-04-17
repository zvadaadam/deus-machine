import { z } from "zod";

import { AgentHarnessSchema, ErrorCategorySchema } from "./enums";

// Canonical agent-server → frontend session notification payloads.
// These are emitted by the agent-server, forwarded through the Electron main process as IPC events,
// and consumed by the frontend.

export const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  agentHarness: AgentHarnessSchema,
  data: z.unknown(),
});
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

export const ErrorResponseSchema = z.object({
  id: z.string(),
  type: z.literal("error"),
  error: z.string(),
  agentHarness: AgentHarnessSchema,
  category: ErrorCategorySchema.optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const EnterPlanModeNotificationSchema = z.object({
  type: z.literal("enter_plan_mode_notification"),
  id: z.string(),
  agentHarness: AgentHarnessSchema,
});
export type EnterPlanModeNotification = z.infer<typeof EnterPlanModeNotificationSchema>;
