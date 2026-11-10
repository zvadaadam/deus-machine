// backend/src/services/account-session.ts
// The Deus account signed in on this desktop, as the backend knows it: the
// session the desktop main process hands over (routes/settings.ts), and the
// Deus Cloud it belongs to. What follows the account reads it here: the relay
// tunnel (remote-machine.service.ts) and the apps the account connected
// through Deus Cloud (integrations/auth/cloud-accounts.ts).

import { getDeusCloudSessionConfig } from "./agent/cloud/config";

export interface AccountSession {
  cloudUrl: string;
  sessionToken: string;
  /** The session's `sub`, read unverified: it scopes local records; Deus Cloud verifies it. */
  accountId: string;
}

function accountOf(sessionToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(sessionToken.split(".")[1] ?? "", "base64url").toString("utf8")
    ) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The desktop's current Deus account session, or null while signed out. */
export function currentAccountSession(): AccountSession | null {
  const { deusCloudUrl, deusCloudSessionToken } = getDeusCloudSessionConfig();
  if (!deusCloudUrl || !deusCloudSessionToken) return null;
  const accountId = accountOf(deusCloudSessionToken);
  if (!accountId) return null;
  return {
    cloudUrl: deusCloudUrl.replace(/\/+$/, ""),
    sessionToken: deusCloudSessionToken,
    accountId,
  };
}
