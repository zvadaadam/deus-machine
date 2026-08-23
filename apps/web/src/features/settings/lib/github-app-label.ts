import type { GithubAppState } from "@/platform/native/deus-cloud";

/**
 * Why the GitHub App card shows no install affordance. "Not configured" has
 * three causes needing different next steps — telling a signed-out user
 * "awaiting App registration" claims the App does not exist when it does,
 * and points them at something only the Deus team can do. Two surfaces
 * render this; deriving it twice is how one of them regressed.
 */
export function githubAppBlockedLabel(data: GithubAppState | undefined): string {
  if (!data?.signedIn) return "Sign in to Deus Cloud first";
  if (data.error === "offline") return "Can't reach Deus Cloud";
  return "Awaiting App registration";
}
