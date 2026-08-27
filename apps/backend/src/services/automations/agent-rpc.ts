// backend/src/services/automations/agent-rpc.ts
// The agent's automation_update tool lands here (deus/automation/update on the
// side channel). Defaults resolve from the CALLING session — repository and
// model — so the agent never guesses ids it doesn't have. Writes go through
// the same service the q:mutate arms use; everything executes in Deus Cloud.

import { match } from "ts-pattern";
import { getDatabase } from "../../lib/database";
import { readStringParam, requireParam } from "../../lib/query-params";
import { getSessionRaw, getWorkspaceRaw } from "../../db";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  listAutomationRuns,
  refreshAutomations,
  toggleAutomation,
  updateAutomation,
  type AutomationInput,
} from "./service";
import { getAutomationRaw } from "./store";

interface SessionDefaults {
  repository_id: string;
  model: string | null;
}

function defaultsFromSession(sessionId: string): SessionDefaults {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new Error(`automation: session not found: ${sessionId}`);
  const workspace = getWorkspaceRaw(db, session.workspace_id);
  if (!workspace) throw new Error(`automation: workspace not found: ${session.workspace_id}`);
  // The session's current model lives on its message rows (model is per-turn).
  // Automation runs are Claude sandboxes, so only a claude-code session's
  // model carries over; anything else falls back to the platform default.
  const lastModel = db
    .prepare(
      `SELECT model FROM messages
        WHERE session_id = ? AND model IS NOT NULL
        ORDER BY seq DESC LIMIT 1`
    )
    .get(sessionId) as { model: string } | undefined;
  return {
    repository_id: workspace.repository_id,
    model: session.agent_harness === "claude-code" ? (lastModel?.model ?? null) : null,
  };
}

/** Resolve an automationId that may be an agnt id or an exact display name. */
function resolveAutomationId(ref: string): string {
  if (getAutomationRaw(ref)) return ref;
  const byName = getDatabase()
    .prepare("SELECT id FROM automations WHERE name = ? ORDER BY id DESC")
    .all(ref) as Array<{ id: string }>;
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) {
    throw new Error(`automation: name "${ref}" is ambiguous — use the id (mode=list to see them).`);
  }
  throw new Error(`automation: not found: ${ref}`);
}

const MODES = ["list", "view", "create", "update", "delete"] as const;
type Mode = (typeof MODES)[number];

export async function handleAutomationToolRequest(
  params: Record<string, unknown>
): Promise<unknown> {
  const sessionId = readStringParam(params, "sessionId");
  if (!sessionId) throw new Error("automation: sessionId is required");
  const rawMode = readStringParam(params, "mode");
  if (!rawMode || !(MODES as readonly string[]).includes(rawMode)) {
    throw new Error(`automation: unknown mode "${rawMode}"`);
  }
  const requireRef = () =>
    resolveAutomationId(requireParam(params, "automationId", "automation_update"));

  return match(rawMode as Mode)
    .with("list", async () => {
      await refreshAutomations().catch(() => {
        // Stale cache beats a failed list — the platform may be briefly away.
      });
      return { automations: listAutomations() };
    })
    .with("view", async () => {
      const id = requireRef();
      await refreshAutomations(id).catch(() => {});
      return { automation: getAutomation(id), runs: listAutomationRuns(id).slice(0, 10) };
    })
    .with("create", async () => {
      const defaults = defaultsFromSession(sessionId);
      const input: AutomationInput = {
        repository_id: readStringParam(params, "repositoryId") ?? defaults.repository_id,
        name: readStringParam(params, "name") ?? "",
        prompt: readStringParam(params, "prompt") ?? "",
        cron: readStringParam(params, "cron") ?? "",
        timezone: readStringParam(params, "timezone") ?? null,
        session_policy: readStringParam(params, "sessionPolicy"),
        model: readStringParam(params, "model") ?? defaults.model,
      };
      return { automation: await createAutomation(input, "agent") };
    })
    .with("update", async () => {
      const id = requireRef();
      const patch: Partial<AutomationInput> = {};
      const name = readStringParam(params, "name");
      const prompt = readStringParam(params, "prompt");
      const cron = readStringParam(params, "cron");
      const sessionPolicy = readStringParam(params, "sessionPolicy");
      if (name !== undefined) patch.name = name;
      if (prompt !== undefined) patch.prompt = prompt;
      if (cron !== undefined) patch.cron = cron;
      if ("timezone" in params) patch.timezone = readStringParam(params, "timezone") ?? null;
      if (sessionPolicy !== undefined) patch.session_policy = sessionPolicy;
      if ("model" in params) patch.model = readStringParam(params, "model") ?? null;

      let automation =
        Object.keys(patch).length > 0 ? await updateAutomation(id, patch) : getAutomation(id);
      const status = readStringParam(params, "status");
      if (status === "active" || status === "paused") {
        automation = await toggleAutomation(id, status);
      }
      return { automation };
    })
    .with("delete", async () => {
      const id = requireRef();
      await deleteAutomation(id);
      return { deleted: true };
    })
    .exhaustive();
}
