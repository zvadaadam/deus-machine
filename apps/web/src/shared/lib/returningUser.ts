/**
 * The returning-user marker for the root domain.
 *
 * deusmachine.ai serves the LANDING to first-time visitors at `/` and the app
 * to returning users — the split is made at the edge (the landing worker) from
 * this cookie. It is a plain boolean marker, not a credential: it says "this
 * browser has used the product", nothing more, so it is safe as a JS-set,
 * parent-domain cookie. Set whenever the product shell actually mounts (which
 * already implies the user got past login/pairing).
 *
 * Scoped to the deusmachine.ai domain family; a no-op everywhere else
 * (localhost dev, Electron), where no edge split exists.
 */
const MARKER = "deus_user=1";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function markReturningUser(): void {
  try {
    const host = window.location.hostname;
    if (host !== "deusmachine.ai" && !host.endsWith(".deusmachine.ai")) return;
    document.cookie =
      `${MARKER}; Domain=.deusmachine.ai; Path=/; Max-Age=${ONE_YEAR_SECONDS}; ` +
      "SameSite=Lax; Secure";
  } catch {
    /* no document (tests) — nothing to mark */
  }
}
