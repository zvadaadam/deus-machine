// backend/src/services/assistants/token.ts
// Verifying an assistant's access token on this computer.
//
// The relay and Deus Cloud only carry the token: nothing they say is taken on
// trust. It must be signed by the pinned sign-in service, for this computer's
// address (`<Deus Cloud>/mcp/<machine id>`) and nothing else, to the account
// this computer serves, held for a person (not an AI agent's own account),
// unexpired, and name the assistant (`client_id`). The same check as Deus
// Cloud's (AGNT `apps/deus-cloud/src/assistants/token.ts`).

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ASSISTANT_ISSUER } from "../../lib/network";
import { SIGN_IN_UNCHECKED } from "./sentences";

/**
 * This computer's address for assistants, in the Deus Cloud at `cloudUrl`:
 * the URL a person pastes into one, and the audience its token must name.
 */
export function assistantAddress(cloudUrl: string, machineId: string): string {
  return `${cloudUrl}/mcp/${machineId}`;
}

/** A relay client's credential is an access token (a JWT), not a device grant. */
export function isAssistantToken(token: string): boolean {
  return token.split(".").length === 3;
}

/** A refusal whose message a person can act on. */
export class AssistantRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantRefusedError";
  }
}

/** Signatures this computer accepts: public-key ones only. */
const ACCEPTED_ALGORITHMS = ["RS256", "ES256"];
/** A Mac's clock may drift a little from the sign-in service's. */
export const CLOCK_TOLERANCE_S = 30;

let keys: JWTVerifyGetKey | null = null;

/** The issuer's public keys, fetched once and refreshed by jose when a new key id appears. */
function issuerKeys(): JWTVerifyGetKey {
  keys ??= createRemoteJWKSet(new URL(`${ASSISTANT_ISSUER.replace(/\/+$/, "")}/oauth2/jwks`));
  return keys;
}

/** Tests only: verify against these keys instead of the issuer's (null restores them). */
export function useAssistantKeys(source: JWTVerifyGetKey | null): void {
  keys = source;
}

export interface Expected {
  /** `<Deus Cloud URL>/mcp/<machine id>`: the address the token was issued for. */
  audience: string;
  /** The account this computer's tunnel serves. */
  accountId: string;
}

/**
 * The assistant a valid token names and when its sign-in ends (epoch seconds),
 * or an `AssistantRefusedError` saying why not.
 */
export async function verifyAssistantToken(
  token: string,
  expected: Expected
): Promise<{ clientId: string; exp: number }> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, issuerKeys(), {
      // The issuer signs with a private key (RS256 today). Pinning asymmetric
      // algorithms means a token can never be checked as a shared-secret one.
      algorithms: ACCEPTED_ALGORITHMS,
      issuer: ASSISTANT_ISSUER,
      audience: expected.audience,
      subject: expected.accountId,
      requiredClaims: ["exp"],
      clockTolerance: CLOCK_TOLERANCE_S,
    }));
  } catch (error) {
    throw new AssistantRefusedError(refusal(error));
  }
  // jose accepts an audience list that contains this address; a token for
  // several could be replayed at each of them, so it must name only this one.
  if (Array.isArray(payload.aud) && payload.aud.length !== 1) {
    throw new AssistantRefusedError("The sign-in is not for this computer alone.");
  }
  // A token an AI agent holds as itself names no person to act for.
  if (payload.sub_profile === "ai_agent") {
    throw new AssistantRefusedError("The sign-in is an AI agent's own, not a person's.");
  }
  const clientId = payload.client_id;
  if (typeof clientId !== "string" || !clientId) {
    throw new AssistantRefusedError("The sign-in does not say which assistant it is.");
  }
  return { clientId, exp: payload.exp as number };
}

function refusal(error: unknown): string {
  if (error instanceof errors.JWTExpired) {
    return "The assistant's sign-in has expired. Connect it to Deus again.";
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return "The sign-in was not issued by Deus.";
    if (error.claim === "aud") return "The sign-in is for another computer.";
    if (error.claim === "sub") {
      return "The sign-in belongs to a different Deus account than this computer's.";
    }
    return "The sign-in is not valid yet or is missing what this computer needs.";
  }
  if (keysUnavailable(error)) return SIGN_IN_UNCHECKED;
  return "The sign-in could not be verified.";
}

/**
 * Whether the sign-in service's keys could not be had: not the assistant's
 * fault. jose throws its plain `JOSEError` (`ERR_JOSE_GENERIC`) only when the
 * key set's URL answers other than 200 or with something that is not JSON;
 * a timeout, a key set that is not one, and a fetch that failed outright
 * (not a JOSEError at all) are the service's too.
 */
function keysUnavailable(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) return true;
  return (
    error.code === errors.JOSEError.code ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid
  );
}
