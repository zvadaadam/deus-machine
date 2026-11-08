import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import type { CloudModelCatalog } from "@shared/cloud-models";
import { getAllSettings, PRIVATE_SETTINGS, saveSetting } from "../services/settings.service";
import { CloudCredentialsBody, parseBody, SaveSettingBody } from "../lib/schemas";
import { getCloudConfig, setCloudRuntimeCredentials } from "../services/agent/cloud/config";
import { getCloudModelLists } from "../services/agent/cloud/models";
import { reconcileRelay } from "../services/relay.service";
import { getLocalAgents } from "../services/agent";
import type { AgentAuthAnswer } from "@shared/agent-auth";
import {
  getCloudSettingsStatus,
  saveCloudGithubToken,
} from "../services/cloud-workspace-init.service";
import { initAutomations } from "../services/automations";
import { AppError, ValidationError } from "../lib/errors";

const app = new Hono();

app.get("/settings", (c) => {
  return c.json(getAllSettings());
});

app.post("/settings", async (c) => {
  const { key, value } = parseBody(SaveSettingBody, await c.req.json());
  if (PRIVATE_SETTINGS.has(key)) throw new ValidationError(`${key} is not a setting`);
  saveSetting(key, value);

  // Turning it on is also how a computer removed from the account is added again.
  if (key === "remote_access_enabled") reconcileRelay({ restart: value === true });

  return c.json({ success: true, key, value });
});

// Each local agent's CLI and login, and the sign-ins under way.
app.get("/settings/agent-auth", async (c) => {
  const answer: AgentAuthAnswer = await Promise.resolve()
    .then(() => getLocalAgents().status())
    .catch((err: unknown) => ({
      auth: [],
      clis: [],
      logins: [],
      error: err instanceof Error ? err.message : String(err),
    }));
  return c.json(answer);
});

// ── Cloud workspaces ────────────────────────────────────────────────

app.get("/settings/cloud", async (c) => {
  return c.json(await getCloudSettingsStatus());
});

// The models Deus Cloud runs, per harness, as the platform lists them.
app.get("/settings/cloud/models", async (c) => {
  const lists = await getCloudModelLists().catch((err: unknown) => {
    // The platform being unreachable is not a backend fault: say what failed.
    throw new AppError(502, err instanceof Error ? err.message : String(err));
  });
  const catalog: CloudModelCatalog = lists
    ? { configured: true, lists }
    : { configured: false, lists: [] };
  return c.json(catalog);
});

app.post("/settings/cloud/github-token", async (c) => {
  const body = (await c.req.json()) as { token?: string };
  const token = body.token?.trim();
  if (!token) throw new ValidationError("token is required");
  await saveCloudGithubToken(token);
  return c.json({ ok: true });
});

/**
 * Only the process that spawned this backend may hand it an account. It passes
 * AUTH_TOKEN at spawn; without the check, any page that found the local port
 * could sign this computer in to another account and host it there. A backend
 * started without one (web dev, the CLI) has no such process and takes no account.
 */
function fromDesktopMain(authorization: string | undefined): boolean {
  const expected = process.env.AUTH_TOKEN;
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
  // Credentials arriving is the moment the automations cache can first (or
  // freshly) mirror the platform — kick a background sync.
  initAutomations();
  return c.json({ ok: true, configured: getCloudConfig() !== null });
});

export default app;
