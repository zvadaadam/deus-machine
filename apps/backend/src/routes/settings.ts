import { Hono } from "hono";
import { getAllSettings, saveSetting } from "../services/settings.service";
import { parseBody, SaveSettingBody } from "../lib/schemas";
import { ensureRelayConnected, disconnectFromRelay } from "../services/relay.service";
import { checkAuth, isConnected, getAgents } from "../services/agent";

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

  // Which agents had their CLI discovered during startup
  const agents = getAgents();
  const claudeInstalled = agents.some((a) => a.type === "claude" && a.initialized);
  const codexInstalled = agents.some((a) => a.type === "codex" && a.initialized);

  const cwd = process.cwd();
  const [claudeResult, codexResult] = await Promise.allSettled([
    claudeInstalled ? checkAuth({ agentType: "claude", cwd }) : Promise.resolve(null),
    codexInstalled ? checkAuth({ agentType: "codex", cwd }) : Promise.resolve(null),
  ]);

  return c.json({
    agents: agents.map((a) => ({ type: a.type, installed: a.initialized })),
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

export default app;
