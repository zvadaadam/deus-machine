// Zod validation schemas for inbound relay frames.
// These validate JSON parsed from WebSocket messages before dispatching.

import { z } from "zod";

// pair_response has a secondary discriminator on `success` — Zod v3's
// discriminatedUnion only supports one discriminator key, so we validate
// the pair_response shape with a union + superRefine on the outer schema.
const pairResponseSchema = z
  .object({
    type: z.literal("pair_response"),
    pairId: z.string(),
    success: z.boolean(),
    deviceToken: z.string().optional(),
    reason: z.string().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.success && !f.deviceToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deviceToken is required when success is true",
        path: ["deviceToken"],
      });
    }
    if (!f.success && !f.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reason is required when success is false",
        path: ["reason"],
      });
    }
  });

// Top-level schema: discriminatedUnion on "type" for all frame types except
// pair_response (which needs the extra refinement). We use z.union to combine
// the discriminatedUnion with the refined pair_response schema.
const baseFrameSchema = z.discriminatedUnion("type", [
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
  z.object({ type: z.literal("pong") }),
]);

export const serverFrameSchema = z.union([baseFrameSchema, pairResponseSchema]);

export const clientAuthFrameSchema = z.object({
  type: z.literal("authenticate"),
  token: z.string(),
});

export const pairerFrameSchema = z.object({
  type: z.literal("pair_request"),
  code: z.string(),
  deviceName: z.string().default("Web Browser"),
});
