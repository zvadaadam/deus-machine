// Zod validation schemas for inbound relay frames.
// These validate JSON parsed from WebSocket messages before dispatching.

import { z } from "zod";

export const FILE_SEGMENT = /^[A-Za-z0-9_-]{22}$/;
const streamId = z.number().int().min(0).max(0xffff_ffff);

// Pairing has a second discriminator: success requires a token, failure requires a reason.
const pairResponse = z.object({ type: z.literal("pair_response"), pairId: z.string() });
const pairResponseSchema = z.discriminatedUnion("success", [
  pairResponse.extend({
    success: z.literal(true),
    deviceToken: z.string().min(1),
    reason: z.string().optional(),
  }),
  pairResponse.extend({
    success: z.literal(false),
    deviceToken: z.string().optional(),
    reason: z.string().min(1),
  }),
]);

const baseFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("register"),
    serverName: z.string().max(200).optional(),
    routeKey: z.string().regex(FILE_SEGMENT).optional(),
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
    type: z.literal("file_head"),
    streamId,
    status: z.number().int(),
    headers: z.record(z.string()),
  }),
  z.object({ type: z.literal("file_end"), streamId, error: z.string().optional() }),
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
