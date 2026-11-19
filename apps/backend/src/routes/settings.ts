import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { readAgentAuth } from "../api/settings";
import { CloudCredentialsBody, parseBody } from "../lib/schemas";
import { cloudOrg, setCloudRuntimeCredentials } from "../services/agent/cloud/config";
import { reconcileRelay } from "../services/relay.service";
import {
  getCloudSettingsStatus,
  saveCloudGithubToken,
} from "../services/cloud-workspace-init.service";
import { initAutomations } from "../services/automations";
import { refreshCloudOrganizations } from "../services/cloud-settings.service";
import { reconcileCloudAccounts } from "../services/integrations";
import { AppError, ValidationError } from "../lib/errors";
import { spawnToken } from "../lib/spawn-token";

const app = new Hono();

// Preferences, agent configuration and the local agents are operations: see
// api/settings.ts. What stays here is still fetched over HTTP, by whom each says.

// `deus status` (apps/cli) lists each local agent's CLI and login.
app.get("/settings/agent-auth", async (c) => c.json(await readAgentAuth()));

// ── Cloud workspaces ────────────────────────────────────────────────

// The web app asks whether this computer is signed in to Deus Cloud (useCloudSettings),
// in one organization (`?organizationId=`, the default when omitted).
app.get("/settings/cloud", async (c) => {
  return c.json(await getCloudSettingsStatus(c.req.query("organizationId") || null));
});

// The web app's Settings → GitHub saves the token cloud sandboxes use (GithubCloudAccess).
app.post("/settings/cloud/github-token", async (c) => {
  const body = (await c.req.json()) as { token?: string; organizationId?: unknown };
  const token = body.token?.trim();
  if (!token) throw new ValidationError("token is required");
  const organizationId =
    typeof body.organizationId === "string" && body.organizationId ? body.organizationId : null;
  await saveCloudGithubToken(token, organizationId);
  return c.json({ ok: true });
});

/**
 * Only the process that spawned this backend may hand it an account. It passes
 * AUTH_TOKEN at spawn; without the check, any page that found the local port
 * could sign this computer in to another account and host it there. A backend
 * started without one (web dev, the CLI) has no such process and takes no account.
 */
function fromDesktopMain(authorization: string | undefined): boolean {
  const expected = spawnToken();
  if (!expected) return false;
  const given = Buffer.from(authorization?.replace(/^Bearer /, "") ?? "");
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// Runtime credential handoff from the desktop main process (D1 handshake):
// the per-device agnt key minted after sign-in, and agent credentials saved
// in Settings. Values live in memory only — durable storage is main's
// safeStorage, never this process or the DB.
app.post("/settings/cloud/credentials", async (c) => {
  if (!fromDesktopMain(c.req.header("authorization"))) {
    throw new AppError(401, "Only the Deus desktop app can set cloud credentials");
  }
  const body = parseBody(CloudCredentialsBody, await c.req.json());
  setCloudRuntimeCredentials(body);
  // Remote access belongs to the signed-in account: follow sign-in, sign-out and switches.
  reconcileRelay();
  // So do the apps the account connected through Deus Cloud.
  void reconcileCloudAccounts();
  // Credentials arriving is the moment the automations cache can first (or
  // freshly) mirror the platform — kick a background sync.
  initAutomations();
  // Every client is told what this backend's cloud is now, and the list is read again.
  refreshCloudOrganizations();
  return c.json({ ok: true, configured: cloudOrg() !== null });
});

export default app;
