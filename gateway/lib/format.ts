// gateway/lib/format.ts
// Pure functions: extract human-readable text from agent SDK messages
// and truncate for messaging platform limits.

/** Telegram message length limit */
const TELEGRAM_MAX_LENGTH = 4096;

/** Default max length for formatted messages */
const DEFAULT_MAX_LENGTH = TELEGRAM_MAX_LENGTH;

/**
 * Extract human-readable text from a sidecar agent message data payload.
 * The data payload mirrors the Claude Agent SDK ConversationEvent structure.
 */
export function extractText(data: unknown): string {
  if (!data || typeof data !== "object") return "";

  const d = data as Record<string, unknown>;

  // Result event — final response
  if (d.type === "result") {
    const result = d as Record<string, unknown>;
    if (result.subtype === "error_max_turns") return "[Agent reached max turns]";
    // Result doesn't always have text — it's a completion signal
    return "";
  }

  // Message event — contains content blocks
  if (d.type === "assistant") {
    return extractFromMessage(d.message);
  }

  // Streaming text delta — partial text
  if (d.type === "text") {
    return typeof d.text === "string" ? d.text : "";
  }

  return "";
}

/**
 * Extract text content from a message object with content blocks.
 */
function extractFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as Record<string, unknown>;

  if (!Array.isArray(msg.content)) return "";

  const parts: string[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;

    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      // Show tool use as a brief indicator
      const name = typeof b.name === "string" ? b.name : "tool";
      parts.push(`[Using ${name}...]`);
    } else if (b.type === "tool_result") {
      // Skip tool results in chat — too verbose
    }
  }

  return parts.join("\n");
}

/**
 * Truncate text to fit within a messaging platform's character limit.
 * Adds a truncation indicator if the text was shortened.
 */
export function truncate(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;

  const suffix = "\n\n... [truncated]";
  return text.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Format a diff stats summary for chat display.
 */
export function formatDiffStats(stats: {
  additions: number;
  deletions: number;
  files_changed: number;
}): string {
  return [
    `Files changed: ${stats.files_changed}`,
    `+${stats.additions} / -${stats.deletions}`,
  ].join("\n");
}

/**
 * Format a workspace list for chat display.
 */
export function formatWorkspaceList(
  repos: Array<{
    repo_name: string;
    workspaces: Array<{ id: string; name: string; state: string }>;
  }>
): string {
  if (repos.length === 0) return "No repos found. Add a repo in the OpenDevs desktop app first.";

  const lines: string[] = [];
  for (const repo of repos) {
    lines.push(`*${repo.repo_name}*`);
    if (repo.workspaces.length === 0) {
      lines.push("  (no workspaces)");
    }
    for (const ws of repo.workspaces) {
      const icon = ws.state === "active" ? "+" : "-";
      lines.push(`  ${icon} ${ws.name} (${ws.state})`);
    }
  }
  return lines.join("\n");
}

/**
 * Format a session status summary for chat display.
 */
export function formatSessionStatus(session: {
  id: string;
  status: string;
  title?: string;
  agent_type?: string;
}): string {
  const lines = [
    `Status: ${session.status}`,
    session.title ? `Title: ${session.title}` : null,
    session.agent_type ? `Agent: ${session.agent_type}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}
