/**
 * Opt-in flag for Path B direct-agnt rendering (default OFF).
 *
 * A cloud session's conversation is normally relayed through the Mac backend
 * over `q:`. With this on, cloud sessions instead connect straight to agnt in
 * the browser (`useCloudDirect`) — the "Mac-closed" render path. Kept a runtime
 * flag (not a build const) so it can be flipped while the seam is behind a
 * curtain, without a rebuild.
 *
 * Toggle in dev: `localStorage.setItem("deus.cloudDirect", "1")` then reload.
 */
import { isCloudDirectWebMode } from "./webCloudDirectConfig";

export function isCloudDirectEnabled(): boolean {
  // A fully Mac-closed web build IS direct by definition — there is no Mac lane
  // to relay through — so it implies this flag; otherwise the dev flag opts a
  // backed build into Path B.
  if (isCloudDirectWebMode()) return true;
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("deus.cloudDirect") === "1";
  } catch {
    return false;
  }
}
