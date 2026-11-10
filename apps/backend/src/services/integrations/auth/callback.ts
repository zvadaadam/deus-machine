// backend/src/services/integrations/auth/callback.ts
// Where a browser sign-in returns: this backend, on this computer's loopback.
// An OAuth sign-in comes back to the path itself with its `state`; a sign-in
// through Deus Cloud comes back to `<path>/<attempt>`.

export const SIGN_IN_CALLBACK_PATH = "/api/integrations/oauth/callback";

let base: string | null = null;

/** Called once the backend listens: `http://localhost:<port>`. */
export function setSignInReturnBase(url: string): void {
  base = url.replace(/\/+$/, "");
}

export function signInReturnUrl(): string {
  if (!base) throw new Error("Deus is still starting; try again in a moment");
  return `${base}${SIGN_IN_CALLBACK_PATH}`;
}
