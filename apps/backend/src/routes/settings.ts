import { Hono } from "hono";
import type { CloudModelCatalog } from "@shared/cloud-models";
import { getAllSettings, saveSetting } from "../services/settings.service";
import { CloudCredentialsBody, parseBody, SaveSettingBody } from "../lib/schemas";
import { getCloudConfig, setCloudRuntimeCredentials } from "../services/agent/cloud/config";
import { getCloudModelLists } from "../services/agent/cloud/models";
import { ensureRelayConnected, disconnectFromRelay } from "../services/relay.service";
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
  saveSetting(key, value);

  if (key === "remote_access_enabled") {
    if (value === true) {
      ensureRelayConnected();
    } else {
      disconnectFromRelay();
    }
  }

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

// Runtime credential handoff from the desktop main process (D1 handshake):
// the per-device agnt key minted after sign-in, and agent credentials saved
// in Settings. Values live in memory only — durable storage is main's
// safeStorage, never this process or the DB.
app.post("/settings/cloud/credentials", async (c) => {
  const body = parseBody(CloudCredentialsBody, await c.req.json());
  setCloudRuntimeCredentials(body);
  // Credentials arriving is the moment the automations cache can first (or
  // freshly) mirror the platform — kick a background sync.
  initAutomations();
  return c.json({ ok: true, configured: getCloudConfig() !== null });
});

export default app;
