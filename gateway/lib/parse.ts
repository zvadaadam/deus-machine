// gateway/lib/parse.ts
// Pure function: parse a text message into a GatewayCommand or null.

import type { GatewayCommand } from "../types";

/**
 * Parse a slash command from a message text.
 * Returns null if the text is not a command (regular message to send to agent).
 */
export function parseCommand(text: string): GatewayCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  // Split into command and args, handle @botname suffix (Telegram groups)
  const [rawCmd, ...args] = trimmed.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();

  switch (cmd) {
    case "/repos":
    case "/list":
      return { type: "repos" };

    case "/workspace":
    case "/ws":
    case "/bind":
      return { type: "workspace", name: args.join(" ") || undefined };

    case "/status":
      return { type: "status" };

    case "/diff":
      return { type: "diff" };

    case "/stop":
    case "/cancel":
      return { type: "stop" };

    case "/new":
      return { type: "new", repoId: args[0] || undefined };

    case "/help":
    case "/start":
      return { type: "help" };

    case "/unbind":
      return { type: "unbind" };

    default:
      return null;
  }
}
