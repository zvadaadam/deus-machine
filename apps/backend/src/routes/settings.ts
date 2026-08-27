import { Hono } from "hono";
import { getAllSettings, saveSetting } from "../services/settings.service";
import { CloudCredentialsBody, parseBody, SaveSettingBody } from "../lib/schemas";
import { getCloudConfig, setCloudRuntimeCredentials } from "../services/agent/cloud/config";
import { ensureRelayConnected, disconnectFromRelay } from "../services/relay.service";
import { checkAuth, isConnected, getAgents } from "../services/agent";
import {
  getCloudSettingsStatus,
  saveCloudGithubToken,
  saveCloudCodexAuth,
  disconnectCloudCodexAuth,
} from "../services/cloud-workspace-init.service";
import { listCloudEnvironments } from "../services/cloud-environment.service";
import { initAutomations } from "../services/automations";
import { ValidationError } from "../lib/errors";
import type { AgentHarness } from "@shared/enums";

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

// Check agent provider auth status (Claude / Codex)
app.get("/settings/agent-auth", async (c) => {
  if (!isConnected()) {
    return c.json({
      agents: [],
      claude: null,
      codex: null,
      error: "Agent server not connected",
    });
  }

  // Only harnesses the engine actually registered appear in the handshake —
  // presence IS availability, so there is no separate `initialized` flag.
  const agents = getAgents();
  const claudeInstalled = agents.some((a) => a.type === "claude-code");

  const cwd = process.cwd();
  const [claudeResult, codexResult] = await Promise.allSettled([
    claudeInstalled ? checkAuth({ agentHarness: "claude-code", cwd }) : Promise.resolve(null),
    // Auth introspection is a Claude-only feature today (the SDK exposes
    // accountInfo); codex reports nothing to check.
    Promise.resolve(null),
  ]);

  return c.json({
    agents: agents.map((a) => ({ type: a.type, installed: true })),
    claude:
      claudeResult.status === "fulfilled"
        ? claudeResult.value
        : { error: String(claudeResult.reason) },
    codex:
      codexResult.status === "fulfilled"
        ? codexResult.value
        : { error: String(codexResult.reason) },
  });
});

// ── Cloud workspaces ────────────────────────────────────────────────

app.get("/settings/cloud", async (c) => {
  return c.json(await getCloudSettingsStatus());
});

// WEB-lane Codex connect/disconnect: the desktop has its own vault+sync
// path (main process); the web app writes the canonical platform secret
// directly — which is the only copy cloud turns read on ANY surface.
app.post("/settings/cloud/codex-auth", async (c) => {
  const body = (await c.req.json()) as { authJson?: string };
  const authJson = body.authJson?.trim();
  if (!authJson) throw new ValidationError("authJson is required");
  await saveCloudCodexAuth(authJson);
  return c.json({ ok: true });
});

app.delete("/settings/cloud/codex-auth", async (c) => {
  await disconnectCloudCodexAuth();
  return c.json({ ok: true });
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

// Org-wide cloud environments (agent-authored recipes on the platform).
app.get("/settings/cloud/environments", async (c) => {
  return c.json(await listCloudEnvironments());
});

export default app;
