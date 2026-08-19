import { Hono } from "hono";
import { getAllSettings, saveSetting } from "../services/settings.service";
import { parseBody, SaveSettingBody } from "../lib/schemas";
import { ensureRelayConnected, disconnectFromRelay } from "../services/relay.service";
import { checkAuth, isConnected, getAgents } from "../services/agent";
import {
  getCloudSettingsStatus,
  saveCloudGithubToken,
} from "../services/cloud-workspace-init.service";
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

app.post("/settings/cloud/github-token", async (c) => {
  const body = (await c.req.json()) as { token?: string };
  const token = body.token?.trim();
  if (!token) throw new ValidationError("token is required");
  await saveCloudGithubToken(token);
  return c.json({ ok: true });
});

export default app;
