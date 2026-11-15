// backend/src/services/assistants/label.ts
// What an assistant is called and where it signs in from. Labels only: they decide nothing.

import type { AccountSession } from "../account-session";

const LOOKUP_TIMEOUT_MS = 10_000;
/** A host as a person reads one: `chatgpt.com`, `localhost:3000`. */
const HOST_SHAPE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/** The host of a URL-shaped client id (its metadata document's), or null. */
export function urlHost(clientId: string): string | null {
  try {
    const url = new URL(clientId);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.host) return url.host;
  } catch {
    // Not a URL.
  }
  return null;
}

/** A readable name without asking anyone: the host of a URL-shaped client id, else the id. */
export function fallbackName(clientId: string): string {
  return urlHost(clientId) ?? clientId;
}

export interface Label {
  name: string | null;
  host: string | null;
}

/**
 * Deus Cloud's name for the assistant and the host its sign-in returns to
 * (`GET /me/assistants/:clientId` answers `{ name, host }`), or null when it
 * could not say.
 */
export async function lookUpLabel(
  session: AccountSession,
  clientId: string
): Promise<Label | null> {
  try {
    const response = await fetch(
      `${session.cloudUrl}/me/assistants/${encodeURIComponent(clientId)}`,
      {
        headers: { authorization: `Bearer ${session.sessionToken}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      }
    );
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as {
      name?: unknown;
      host?: unknown;
    } | null;
    const name = typeof data?.name === "string" ? data.name.trim().slice(0, 80) : "";
    const host = typeof data?.host === "string" ? data.host.trim().toLowerCase() : "";
    const label = {
      name: name || null,
      host: host.length <= 253 && HOST_SHAPE.test(host) ? host : null,
    };
    return label.name || label.host ? label : null;
  } catch {
    return null;
  }
}
