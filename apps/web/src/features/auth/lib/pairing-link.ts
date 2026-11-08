/**
 * A pairing link carries its one-use code in the URL fragment
 * (`/s/<computer>#pair=SOFT+TIGER`), which never reaches a server. Signing in
 * first is a full-page round trip that drops the fragment, so the code waits
 * in this tab's sessionStorage until the pairing page claims it.
 */
const STASH_PREFIX = "deus.pendingPair:";

/** Normalize to "WORD WORD"; null unless it is a two-word code. */
export function normalizePairCode(raw: string): string | null {
  const normalized = raw.replace(/[-_+]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  const parts = normalized.split(" ");
  return parts.length === 2 && parts.every((p) => /^[A-Z]{2,}$/.test(p)) ? normalized : null;
}

function codeInFragment(hash: string): string | null {
  const pair = new URLSearchParams(hash.replace(/^#/, "")).get("pair");
  return pair ? normalizePairCode(pair) : null;
}

/** A code from a pasted link, or null. */
export function pairCodeFromLink(text: string): string | null {
  try {
    return codeInFragment(new URL(text.trim()).hash);
  } catch {
    return null;
  }
}

function scrubUrl(): void {
  const url = new URL(window.location.href);
  if (!url.hash.includes("pair=")) return;
  const rest = new URLSearchParams(url.hash.replace(/^#/, ""));
  rest.delete("pair");
  url.hash = rest.toString();
  window.history.replaceState(window.history.state, "", url);
}

function stashed(serverId: string): string | null {
  try {
    const code = sessionStorage.getItem(`${STASH_PREFIX}${serverId}`);
    return code ? normalizePairCode(code) : null;
  } catch {
    return null;
  }
}

/** Keep the link's code across the sign-in redirect. */
export function stashPairCode(serverId: string): void {
  const code = codeInFragment(window.location.hash);
  if (!code) return;
  try {
    sessionStorage.setItem(`${STASH_PREFIX}${serverId}`, code);
  } catch {
    // Without storage the user types the code after signing in.
  }
  scrubUrl();
}

/** The link's code for this computer: from the URL, else kept from before sign-in. */
export function peekPairCode(serverId: string): string | null {
  return codeInFragment(window.location.hash) ?? stashed(serverId);
}

/** A code is used once; drop it from the URL and storage before submitting it. */
export function discardPairCode(serverId: string): void {
  scrubUrl();
  try {
    sessionStorage.removeItem(`${STASH_PREFIX}${serverId}`);
  } catch {
    // Nothing was kept.
  }
}

/** The link the computer's QR code encodes. */
export function pairingLink(appOrigin: string, serverId: string, code: string): string {
  return `${appOrigin}/s/${encodeURIComponent(serverId)}#pair=${code.replace(/ /g, "+")}`;
}
