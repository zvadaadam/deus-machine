import { z } from "zod";

import { AgentTypeSchema, ErrorCategorySchema, SessionStatusSchema } from "./enums";

// Canonical agent-server → frontend session notification payloads.
// These are emitted by the agent-server, forwarded through the Electron main process as IPC events,
// and consumed by the frontend.

export const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  agentType: AgentTypeSchema,
  data: z.unknown(),
});
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

export const ErrorResponseSchema = z.object({
  id: z.string(),
  type: z.literal("error"),
  error: z.string(),
  agentType: AgentTypeSchema,
  category: ErrorCategorySchema.optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const EnterPlanModeNotificationSchema = z.object({
  type: z.literal("enter_plan_mode_notification"),
  id: z.string(),
  agentType: AgentTypeSchema,
});
export type EnterPlanModeNotification = z.infer<typeof EnterPlanModeNotificationSchema>;

export const StatusChangedNotificationSchema = z.object({
  type: z.literal("status_changed"),
  id: z.string(),
  agentType: AgentTypeSchema,
  status: SessionStatusSchema,
  errorMessage: z.string().optional(),
  errorCategory: ErrorCategorySchema.optional(),
  workspaceId: z.string().optional(),
});
export type StatusChangedNotification = z.infer<typeof StatusChangedNotificationSchema>;

export const SessionNotificationSchema = z.union([
  MessageResponseSchema,
  ErrorResponseSchema,
  EnterPlanModeNotificationSchema,
  StatusChangedNotificationSchema,
]);
export type SessionNotification = z.infer<typeof SessionNotificationSchema>;
