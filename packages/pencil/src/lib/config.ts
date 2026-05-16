// packages/pencil/src/lib/config.ts

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

const HOME = homedir();

// ---- App identity ---------------------------------------------------------
export const APP_NAME = "pencil-app";
export const APP_VERSION = "0.2.0";

// ---- Pencil cloud ---------------------------------------------------------
/** Default production API base. We pin this when spawning the CLI so a
 *  dev shell with NODE_ENV=development can't redirect to localhost. */
export const PENCIL_PROD_API_BASE = "https://api.pencil.dev";

// ---- Auth files -----------------------------------------------------------
/** Where Deus persists a user-pasted CLI key. mode 0600 enforced on write. */
export const DEUS_CLI_KEY_FILE = join(HOME, ".deus", "pencil", "cli-key");
/** Pencil CLI's own session file from `pencil login`. We read but never write. */
export const PENCIL_SESSION_FILE = join(HOME, ".pencil", "session-cli.json");
/** Where the embedded editor's web session lives. The editor sends
 *  `notify("set-session", {email, token})` after the user signs in via
 *  the cloud sign-in card. We persist that {email, token} here so the
 *  next launch's `get-session` returns it instead of forcing a re-login. */
export const DEUS_EDITOR_SESSION_FILE = join(HOME, ".deus", "pencil", "editor-session.json");

// ---- Pencil host (TransportServer) ---------------------------------------
/** App registry directory — the bundled mcp-server binary reads
 *  `~/.pencil/apps/<app-name>` to find the WebSocket port of the host
 *  it's been told to connect to via `-app <name>`. */
export const PENCIL_APPS_DIR = join(HOME, ".pencil", "apps");
/** Prefix for our app names in the registry. Each running AAP instance appends
 *  a stable hash so concurrent workspaces do not overwrite each other's host
 *  port file. */
export const PENCIL_HOST_APP_NAME_PREFIX = "deus";

export function pencilHostAppNameFor(opts: {
  workspace: string;
  storage: string;
  port: number;
}): string {
  const seed = `${opts.workspace}\0${opts.storage}\0${opts.port}`;
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `${PENCIL_HOST_APP_NAME_PREFIX}-${hash}`;
}

// ---- Tools / format whitelist --------------------------------------------
export const ALLOWED_EXPORT_FORMATS = ["png", "jpeg", "webp", "pdf"] as const;
export type ExportFormat = (typeof ALLOWED_EXPORT_FORMATS)[number];

// ---- Limits ---------------------------------------------------------------
/** Tail size we keep around for op stderr — surfaced to the agent on
 *  failure. 32 KB is enough for stack traces; bigger wastes JSON bytes. */
export const STDERR_TAIL_BYTES = 32 * 1024;
/** Max log buffer the iframe shows in its tail strip. */
export const IFRAME_LOG_TAIL_BYTES = 3 * 1024;
