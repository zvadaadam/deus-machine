/** Reading Project inputs back out of a managed conversation's user echo. */

interface OutcomePayload {
  agentId?: string;
  outcome?: { status?: string; reason?: string; error?: { message?: string } };
  reports?: { summary?: string }[];
}

/** A child's finished turn, as delivered to its coordinator. */
export function describeOutcome(text: string): {
  agentId: string | null;
  verb: string;
  detail: string | null;
  tone: "done" | "stopped" | "failed";
} {
  let payload: OutcomePayload;
  try {
    payload = JSON.parse(text) as OutcomePayload;
  } catch {
    return { agentId: null, verb: "reported back", detail: text, tone: "done" };
  }
  const status = payload.outcome?.status;
  const report = payload.reports?.find((item) => item.summary?.trim())?.summary?.trim() ?? null;
  const detail = report ?? payload.outcome?.error?.message ?? payload.outcome?.reason ?? null;
  const agentId = payload.agentId ?? null;
  if (status === "cancelled" || status === "interrupted")
    return { agentId, verb: "was stopped", detail, tone: "stopped" };
  if (status === "failed" || status === "error")
    return { agentId, verb: "failed", detail, tone: "failed" };
  return { agentId, verb: report ? "reported a result" : "finished", detail, tone: "done" };
}
