// Relay admission: Deus Cloud signs a one-use ticket for one account, machine
// and role (AGNT `apps/deus-cloud/src/remote-access/tickets.ts`); the relay
// verifies it with public keys only. Browsers cannot set headers on a
// WebSocket, so every peer sends the ticket as its second subprotocol.

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { RELAY_PROTOCOL } from "../../../shared/types/relay";

export { RELAY_PROTOCOL };
export const TICKET_ISSUER = "deus-cloud";
export const TICKET_AUDIENCE = "deus-relay";
export const TICKET_TYPE = "deus-relay-ticket+jwt";
/** Deus Cloud issues 60s tickets; anything that claims longer was not minted for dialing. */
const MAX_TICKET_LIFETIME_S = 300;
const MAX_CLOCK_SKEW_S = 30;
const MAX_TICKET_LENGTH = 4096;

export const MACHINE_ID = /^[0-9a-f]{16}$/;

export const admissionSchema = z
  .object({
    accountId: z.string().min(1).max(256),
    machineId: z.string().regex(MACHINE_ID),
    role: z.enum(["host", "client"]),
    ticketId: z.string().min(1).max(128),
    /** Epoch ms after which the ticket's id no longer needs remembering. */
    expiresAt: z.number().int(),
  })
  .strict();
export type Admission = z.infer<typeof admissionSchema>;
export type RelayRole = Admission["role"];

const claimsSchema = z.object({
  sub: z.string().min(1).max(256),
  mid: z.string().regex(MACHINE_ID),
  role: z.enum(["host", "client"]),
  jti: z.string().min(1).max(128),
  iat: z.number().int(),
  exp: z.number().int(),
});

export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketError";
  }
}

/** `Sec-WebSocket-Protocol: deus.relay.v2, <ticket>` → the ticket, or null. */
export function ticketFromProtocols(header: string | null | undefined): string | null {
  const offered = header?.split(",").map((part) => part.trim()) ?? [];
  if (offered.length !== 2 || offered[0] !== RELAY_PROTOCOL) return null;
  return offered[1] || null;
}

let cached: { source: string; keys: ReturnType<typeof createLocalJWKSet> } | null = null;

function keySet(source: string): ReturnType<typeof createLocalJWKSet> {
  if (cached?.source !== source) {
    cached = { source, keys: createLocalJWKSet(JSON.parse(source) as JSONWebKeySet) };
  }
  return cached.keys;
}

export async function verifyTicket(
  jwks: string | undefined,
  ticket: string,
  now = Date.now()
): Promise<Admission> {
  if (!jwks) throw new TicketError("Relay ticket keys are not configured");
  if (ticket.length > MAX_TICKET_LENGTH) throw new TicketError("Ticket is too large");
  let keys: ReturnType<typeof createLocalJWKSet>;
  try {
    keys = keySet(jwks);
  } catch {
    throw new TicketError("Relay ticket keys are misconfigured");
  }
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(ticket, keys, {
      algorithms: ["ES256"],
      issuer: TICKET_ISSUER,
      audience: TICKET_AUDIENCE,
      typ: TICKET_TYPE,
      requiredClaims: ["sub", "jti", "iat", "exp"],
      currentDate: new Date(now),
    }));
  } catch {
    throw new TicketError("Ticket is invalid or expired");
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw new TicketError("Ticket claims are invalid");
  const { sub, mid, role, jti, iat, exp } = claims.data;
  if (iat > Math.floor(now / 1000) + MAX_CLOCK_SKEW_S || exp - iat > MAX_TICKET_LIFETIME_S) {
    throw new TicketError("Ticket lifetime is invalid");
  }
  return { accountId: sub, machineId: mid, role, ticketId: jti, expiresAt: exp * 1000 };
}
