// apps/web/src/features/browser/lib/cloudPreview.ts
// The cloud computer's dev-server preview: agnt streams the sandbox's public
// host template (`https://{{port}}-<sandboxId>.e2b.app`); the Browser tab
// substitutes the port the user's server listens on.
//
// v1 posture (deliberate, documented): the URL is PUBLIC — the unguessable
// sandbox id is the only secret, exactly like the platform's own sidecar
// reach. An authenticated proxy through the agnt Worker is the graduation
// step before any external exposure; this slice validates the port UX.

export const CLOUD_PREVIEW_PORT_PLACEHOLDER = "{{port}}";
export const DEFAULT_CLOUD_PREVIEW_PORT = 3000;
/** The ports dev servers reach for first — one tap instead of a keyboard. */
export const CLOUD_PREVIEW_QUICK_PORTS = [3000, 5173, 8080] as const;

/** A valid TCP port, or null. Accepts "3000", 3000, " 5173 " — and only
 *  whole numbers: "3000abc" or "1e3" must not silently become another port. */
export function normalizePreviewPort(value: string | number): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else {
    const trimmed = value.trim();
    if (!/^\d{1,5}$/.test(trimmed)) return null;
    n = Number(trimmed);
  }
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * The preview URL for a port, or null when the template is absent/malformed.
 * The template must carry the placeholder — a bare host would silently
 * preview the wrong port (the sidecar's own, or nothing).
 *
 * `rest` is what an address from the chat adds to the port: its path, query
 * and fragment (`/dash?a=1`). It never names a host: the host is always the
 * template's, so a new template (a replaced computer) rebases the same rest.
 */
export function resolveCloudPreviewUrl(
  template: string | null | undefined,
  port: number,
  rest?: string
): string | null {
  if (!template || !template.includes(CLOUD_PREVIEW_PORT_PLACEHOLDER)) return null;
  if (normalizePreviewPort(port) === null) return null;
  const base = template.split(CLOUD_PREVIEW_PORT_PLACEHOLDER).join(String(port));
  if (!rest) return base;
  try {
    // Appended to the origin, never resolved against it: `//elsewhere/x` stays a path.
    return new URL(`${new URL(base).origin}${rest.startsWith("/") ? rest : `/${rest}`}`).href;
  } catch {
    return null;
  }
}

/** An address opened from the chat, as the preview keeps it: its port and path, no host. */
export interface CloudPreviewChatAddress {
  port: number;
  rest: string;
}

/**
 * The address the preview shows for its port: the chat's path while the port is
 * still the one the chat named, on the current template, so a replaced computer
 * shows the same page on its own host. A null `fromChat` (a port chosen by hand)
 * is the port's root.
 */
export function cloudPreviewAddress(
  template: string | null | undefined,
  port: number,
  fromChat: CloudPreviewChatAddress | null
): string | null {
  return resolveCloudPreviewUrl(
    template,
    port,
    fromChat?.port === port ? fromChat.rest : undefined
  );
}

const PORT_STORAGE_PREFIX = "deus:cloud-preview-port:";

/** The last port used for this workspace's preview (per workspace, local). */
export function readStoredPreviewPort(workspaceId: string): number {
  try {
    const stored = localStorage.getItem(PORT_STORAGE_PREFIX + workspaceId);
    return (stored && normalizePreviewPort(stored)) || DEFAULT_CLOUD_PREVIEW_PORT;
  } catch {
    return DEFAULT_CLOUD_PREVIEW_PORT;
  }
}

export function storePreviewPort(workspaceId: string, port: number): void {
  try {
    localStorage.setItem(PORT_STORAGE_PREFIX + workspaceId, String(port));
  } catch {
    /* localStorage unavailable */
  }
}
