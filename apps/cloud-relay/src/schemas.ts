// Zod validation schemas for inbound relay frames.
// These validate JSON parsed from WebSocket messages before dispatching.

import { z } from "zod";

export const serverFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("register"),
    serverId: z.string(),
    relayToken: z.string(),
    serverName: z.string().optional(),
  }),
  z.object({
    type: z.literal("data"),
    clientId: z.string(),
    payload: z.string(),
  }),
  z.object({
    type: z.literal("auth_response"),
    clientId: z.string(),
    allowed: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("pair_response"),
    pairId: z.string(),
    success: z.boolean(),
    deviceToken: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal("pong") }),
]);

export const clientAuthFrameSchema = z.object({
  type: z.literal("authenticate"),
  token: z.string(),
});

export const pairerFrameSchema = z.object({
  type: z.literal("pair_request"),
  code: z.string(),
  deviceName: z.string().default("Web Browser"),
});
