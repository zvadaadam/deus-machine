// agent-server/agents/deus-tools/automations.ts
//
// One mode-discriminated automations tool (the ChatGPT `automation_update`
// shape). Thin wrapper: validate args, call HostRpc.requestAutomationUpdate,
// format the result. The backend's automations.service is the single writer —
// the same service the UI's q:mutate path uses, so the Automations view
// updates live when the agent writes. Automations are cloud-only: the agnt
// platform schedules and runs them in sandboxes, Mac open or closed.

import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getErrorMessage } from "@shared/lib/errors";
import { HostRpc } from "../../host-link";
import { tool } from "./sdk-tool";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const DESCRIPTION = `Create, update, view, list, or delete Deus automations — recurring agent runs on a schedule ("review open PRs every morning", "nightly dependency audit", a reminder, a monitor). Use this whenever the user asks for a scheduled task, recurring run, automation, reminder, or asks you to watch something, check back later, or keep working on a cadence. This is THE scheduler in Deus — always use it for scheduling, never any built-in cron or task tools.

An automation is a prompt Deus Cloud runs on a schedule in a sandbox — it fires even when this machine is closed. It targets a repository (defaults to THIS session's repo, which needs a git remote) and runs Claude with the given model (defaults to this session's model). Requires the user to be signed in to Deus Cloud.

Rules:
- \`cron\` is a 5-field cron expression evaluated in \`timezone\` (IANA; omit for UTC). Fires must be ≥5 minutes apart. NEVER show raw cron to the user — describe schedules in words ("weekdays at 9:00").
- \`prompt\` describes ONLY the task. No schedule, repository, or model details in it — those are separate fields. Write it to run unattended.
- Prefer updating an existing automation over creating a near-duplicate: call mode=list first when unsure, then mode=update with the resolved id.
- sessionPolicy: fresh_session (default) starts a new sandbox chat per run; same_session keeps continuing one chat (follow-ups/monitors).
- Pause/resume via mode=update with status.`;

export function createAutomationTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "automation_update",
      DESCRIPTION,
      {
        mode: z
          .enum(["list", "view", "create", "update", "delete"])
          .describe("list = all automations; view/update/delete need automationId."),
        automationId: z
          .string()
          .optional()
          .describe("Automation id (or exact name) for view/update/delete."),
        name: z
          .string()
          .optional()
          .describe("Short human-readable name. Pick a concise one if the user didn't."),
        prompt: z
          .string()
          .optional()
          .describe("The task itself — self-sufficient, no schedule/repo/model details."),
        cron: z
          .string()
          .optional()
          .describe('5-field cron, e.g. "0 9 * * 1-5" for weekdays at 9:00.'),
        timezone: z
          .string()
          .nullable()
          .optional()
          .describe("IANA timezone the schedule is evaluated in. Omit for UTC."),
        sessionPolicy: z.enum(["fresh_session", "same_session"]).optional(),
        model: z
          .string()
          .nullable()
          .optional()
          .describe("Claude model id for runs. Defaults to this session's current model."),
        status: z
          .enum(["active", "paused"])
          .optional()
          .describe("mode=update only: pause or resume the automation."),
      },
      async (args: Record<string, unknown>) => {
        try {
          const response = await HostRpc.requestAutomationUpdate({
            sessionId,
            ...(args as object),
          } as Parameters<typeof HostRpc.requestAutomationUpdate>[0]);
          return textResult(JSON.stringify(response, null, 2));
        } catch (err) {
          return textResult(`Automation error: ${getErrorMessage(err)}`);
        }
      }
    ),
  ];
}
