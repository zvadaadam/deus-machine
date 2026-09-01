/**
 * `deus feedback` — send product feedback or a feature request to the Deus team.
 *
 * The channel for what Deus should DO better: missing features, confusing UX,
 * broken flows, or things that worked notably well. Reports land on the team's
 * Hivenet board; replies come back as `guidance` when the printed thread is
 * resumed, and the team's questions ride back as `ask`. Posting is keyless by
 * design — the project slug is the address — so this talks to the HTTP endpoint
 * directly instead of adding a dependency to the published CLI.
 */

import { randomUUID } from "node:crypto";
import { c, blank, success, error, hint, info } from "./ui.js";

const HIVENET_ENDPOINT = "https://hivenet.app/v1/feedback";

export interface FeedbackPayload {
  v: 1;
  to: "deus";
  category: string;
  feedback: string;
  subject?: string;
  thread: { id: string };
  client: { name: string; version: string };
  consent: { telemetry: boolean };
}

interface FeedbackResponse {
  id?: string;
  thread?: { id?: string };
  resume?: string;
  guidance?: string;
  ask?: { prompt?: string; command?: string };
  known_issue?: { title?: string; note?: string };
}

/** Pure payload builder (unit-tested). */
export function buildFeedbackPayload(
  message: string,
  version: string,
  opts: { subject?: string; category?: string; threadId?: string } = {}
): FeedbackPayload {
  return {
    v: 1,
    to: "deus",
    category: opts.category ?? "cli",
    feedback: message,
    ...(opts.subject ? { subject: opts.subject } : {}),
    thread: { id: opts.threadId ?? randomUUID().replaceAll("-", "") },
    client: { name: "deus-cli", version },
    consent: { telemetry: false },
  };
}

/** Send feedback; prints the thread id and any guidance/ask from the team. */
export async function sendFeedback(
  message: string,
  version: string,
  opts: { subject?: string; category?: string } = {}
): Promise<void> {
  const trimmed = message.trim();
  if (!trimmed) {
    error("Feedback message is required.");
    blank();
    info("Tell the Deus team what you need — feature requests, confusing UX, broken flows:");
    hint(
      `  ${c.cyan('deus feedback "feature request: let me pin a workspace to the top of the sidebar"')}`
    );
    hint(
      `  ${c.cyan('deus feedback --subject "deus pair" "the QR code renders off-screen on small terminals"')}`
    );
    process.exitCode = 1;
    return;
  }

  const payload = buildFeedbackPayload(trimmed, version, opts);

  let response: Response;
  try {
    response = await fetch(HIVENET_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    error("Could not reach hivenet.app — feedback not sent.");
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    error(`Feedback submission failed (${response.status}).`);
    process.exitCode = 1;
    return;
  }

  const body = (await response.json().catch(() => ({}))) as FeedbackResponse;
  success("Feedback sent to the Deus team.");
  const threadId = body.thread?.id ?? payload.thread.id;
  hint(
    `Thread: ${c.cyan(threadId)} — continue with ${c.cyan(`npx hivenet --to deus --resume ${threadId}`)}`
  );
  if (body.known_issue?.title) {
    blank();
    info(`Known issue: ${body.known_issue.title}`);
    if (body.known_issue.note) info(`Deus team: ${body.known_issue.note}`);
  }
  if (body.guidance) {
    blank();
    info(`Deus team: ${body.guidance}`);
  }
  if (body.ask?.prompt) {
    blank();
    info(`Deus asks: ${body.ask.prompt}`);
    if (body.ask.command) hint(`Answer (only if grounded): ${c.cyan(body.ask.command)}`);
  }
}
