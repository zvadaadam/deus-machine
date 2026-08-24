/**
 * GitHub origin parsing, shared by the backend and the settings UI.
 *
 * These two must agree: the backend decides whether it can mint a GitHub App
 * installation token for a repo, and Settings tells the user whether the
 * installed App covers it. When the UI used looser regexes it claimed a repo
 * was uncovered — and asked for a PAT — for origins the backend handled fine.
 */

/**
 * Normalize scp-style and ssh:// git remotes to their https form.
 *
 * Sandboxes carry no ssh keys — https clones work anonymously for public
 * repos and via the org's `github_token` secret for private ones (agnt's
 * git-auth step writes https credentials and already rewrites ssh→https,
 * but only WHEN a token exists; normalizing here makes public ssh-origin
 * repos work with no token at all).
 */
export function httpsOrigin(url: string): string {
  const scp = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:git@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url;
}

/**
 * `owner/name` when the origin really is GitHub, else null.
 *
 * Parsed, never substring-matched: `/github\.com[/:]…/` also matches
 * `https://evil.example/github.com/a/b`, which would mint a GitHub App
 * installation token and hand it to a workspace that clones from — and so
 * sends the token to — an unrelated host.
 */
export function githubRepoSlug(originUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpsOrigin(originUrl));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) return null;
  return `${parts[0]}/${parts[1]}`;
}
