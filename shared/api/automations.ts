/** Automations: prompts that run on a schedule, and their runs. */

import { z } from "zod";
import { AutomationSessionPolicySchema, AutomationStatusSchema } from "../enums";
import type { Automation, AutomationRun } from "../types/automation";
import { live, out, write } from "./op";

const automationId = z.object({ automationId: z.string().min(1) });

/**
 * What the person chooses for an automation. The host checks what the types
 * here cannot say: the name and prompt are not empty, runs are at least five
 * minutes apart, and Deus Cloud runs the model at the thinking level named.
 */
const automationFields = z.object({
  /** The repository its runs work in; it needs a git remote. */
  repository_id: z.string(),
  name: z.string(),
  prompt: z.string(),
  /** Five cron fields. */
  cron: z.string(),
  /** An IANA name; UTC when null or left out. */
  timezone: z.string().nullable().optional(),
  /** A new chat per run (`fresh_session`, the default) or one chat continued. */
  session_policy: AutomationSessionPolicySchema.optional(),
  /** A new automation must name both of these. */
  model: z.string().nullable().optional(),
  thinking_level: z.string().nullable().optional(),
});

/** The account's automations, as this computer last read them from Deus Cloud. */
export const automations = live({ name: "automations", output: out<Automation[]>() });

/** One automation's latest runs, newest first. */
export const automationRuns = live({
  name: "automation_runs",
  input: automationId,
  output: out<AutomationRun[]>(),
});

/** Create an automation, or with `automationId` change the fields named and keep the rest. */
export const saveAutomation = write({
  name: "saveAutomation",
  input: z.union([automationFields.partial().extend(automationId.shape), automationFields], {
    error:
      "expected an automationId with the fields to change, or a new automation's repository_id, name, prompt and cron",
  }),
  output: out<Automation>(),
});

export const deleteAutomation = write({
  name: "deleteAutomation",
  input: automationId,
  output: out<void>(),
});

/** Pause an automation, or resume it. */
export const toggleAutomation = write({
  name: "toggleAutomation",
  input: automationId.extend({ status: AutomationStatusSchema }),
  output: out<Automation>(),
});

/** Start a run now, whatever the schedule says. Works on a paused automation too. */
export const runAutomationNow = write({
  name: "runAutomationNow",
  input: automationId,
  output: out<{ runId: string }>(),
});

/**
 * Read Deus Cloud again: one automation and its runs, or without an id the
 * whole list. The result arrives on `automations` and `automation_runs`.
 */
export const refreshAutomations = write({
  name: "refreshAutomations",
  input: z.object({ automationId: z.string().optional() }),
  output: out<void>(),
});

/** Open a run's sandbox as a workspace here, with the run's chat in it. */
export const openAutomationRun = write({
  name: "openAutomationRun",
  input: z.object({ runId: z.string().min(1) }),
  output: out<{ workspaceId: string; sessionId: string }>(),
});
