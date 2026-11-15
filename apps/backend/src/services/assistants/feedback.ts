// backend/src/services/assistants/feedback.ts
// An assistant's feedback about Deus itself, sent to the Deus team's Hivenet
// board: the project `deus`, where `deus feedback` (apps/cli) and the agents
// that follow AGENTS.md send theirs. Posting is keyless (the project slug is
// the address). Only the report goes: no environment, no files, nothing about
// the person or this computer (`consent.telemetry: false`).

import { randomUUID } from "node:crypto";

const HIVENET_ENDPOINT = "https://hivenet.app/v1/feedback";
const TIMEOUT_MS = 10_000;

/** Hivenet's own category names, the ones an outside assistant has a use for. */
export const FEEDBACK_CATEGORIES = ["tool", "mcp", "ux", "docs", "model", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export interface FeedbackReport {
  category: FeedbackCategory;
  message: string;
  subject?: string;
  /** Who files it: the tools, by name and version. */
  client: { name: string; version: string };
}

/** What the board answered: the thread, and the team's words when it has any. */
export interface FeedbackReceipt {
  threadId: string;
  guidance?: string;
  knownIssue?: string;
}

/** The board could not be reached, or refused the report; nothing was recorded. */
export class FeedbackNotSent extends Error {}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export async function sendFeedback(report: FeedbackReport): Promise<FeedbackReceipt> {
  const thread = randomUUID().replaceAll("-", "");
  let response: Response;
  try {
    response = await fetch(HIVENET_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        to: "deus",
        category: report.category,
        feedback: report.message,
        ...(report.subject ? { subject: report.subject } : {}),
        thread: { id: thread },
        client: report.client,
        consent: { telemetry: false },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new FeedbackNotSent("The Deus team's feedback board could not be reached.");
  }
  if (!response.ok) {
    throw new FeedbackNotSent(`The Deus team's feedback board refused it (${response.status}).`);
  }
  const body = ((await response.json().catch(() => null)) ?? {}) as {
    thread?: { id?: unknown };
    guidance?: unknown;
    known_issue?: { title?: unknown; note?: unknown };
  };
  const knownIssue = [text(body.known_issue?.title), text(body.known_issue?.note)]
    .filter(Boolean)
    .join(": ");
  return {
    threadId: text(body.thread?.id) ?? thread,
    ...(text(body.guidance) ? { guidance: text(body.guidance) } : {}),
    ...(knownIssue ? { knownIssue } : {}),
  };
}
