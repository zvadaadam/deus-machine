/**
 * Asking GitHub about a repository that may have no folder on this computer:
 * its default branch and its branches, and the organization's installation
 * token that lets a cloud sandbox (and these reads) reach a private one.
 *
 * Every call to GitHub's REST API goes to `githubApiUrl`, whose base
 * `DEUS_GITHUB_API_URL` overrides (tests and journeys point it at a scripted
 * GitHub). A token is sent to GitHub only, never returned to a client or logged.
 */

import { githubRepoSlug } from "@shared/git-origin";
import { cloudAccount } from "./agent/cloud/config";

/** Provisioning waits on the mint, so it must fail fast rather than park the row. */
const MINT_TIMEOUT_MS = 10_000;

/**
 * How long one answer about a repository is reused. The access gate, the
 * branch list, the default branch and provisioning all ask about the same
 * repository within moments; one answer serves them, a "cannot reach"
 * included. Short, so a grant made in the browser is seen soon (and the gate,
 * while it waits for one, asks afresh).
 */
export const GITHUB_ANSWER_TTL_MS = 30_000;

type Remembered<T> = { at: number; answer: Promise<T> };
const mints = new Map<string, Remembered<{ token: string | null; definitive: boolean }>>();
const publicProbes = new Map<string, Remembered<boolean | null>>();
/** The refusal last logged per (organization, repository): logged again only when it changes. */
const loggedRefusals = new Map<string, number>();

/** Reuse an answer still fresh, else ask once (concurrent askers share the one request). */
function remembered<T>(
  cache: Map<string, Remembered<T>>,
  key: string,
  fresh: boolean,
  ask: () => Promise<{ answer: T; keep: boolean }>
): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < GITHUB_ANSWER_TTL_MS) return hit.answer;
  const asked = ask();
  const answer = asked.then((result) => result.answer);
  cache.set(key, { at: Date.now(), answer });
  // An answer that is not GitHub's or deus-cloud's (a timeout, a network
  // failure) is not kept: the next asker tries again.
  void asked.then(
    ({ keep }) => {
      if (!keep && cache.get(key)?.answer === answer) cache.delete(key);
    },
    () => cache.delete(key)
  );
  return answer;
}

/** Forget every remembered answer (an account change; tests). */
export function forgetGithubAnswers(): void {
  mints.clear();
  publicProbes.clear();
  loggedRefusals.clear();
}

/** A repository's branches are read up to this many (three pages of a hundred). */
export const BRANCH_LIST_CAP = 300;
const BRANCH_PAGE_SIZE = 100;

/** The one place GitHub's API base is read. */
export function githubApiUrl(path: string): string {
  const base = (process.env.DEUS_GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  return `${base}${path}`;
}

/**
 * Mint a per-repo GitHub App installation token via deus-cloud (1-hour,
 * down-scoped to exactly this repository). Best-effort by design: missing
 * mint context, an expired session, an uncovered repo, or an unregistered
 * App all resolve to a null token — the workspace then rides the org PAT
 * secret (or clones anonymously when the repo is public).
 *
 * `definitive` is the DESTRUCTIVE-ACTION gate: true only when deus-cloud
 * positively answered "this identity may not mint for this repo" (403/404)
 * or the origin has no slug at all. A timeout, 5xx, network error or
 * missing mint context is an UNKNOWN — callers that remove or blank
 * existing credentials on a null token must not do so on unknowns, or a
 * ten-second deus-cloud blip strips a working sandbox of its git access.
 */
export async function mintRepoInstallationToken(
  originUrl: string,
  /** The organization of the workspace the token is for, never a global one: an
   *  installation token is that organization's GitHub access. */
  orgId: string | null,
  /** Ask deus-cloud again rather than reuse a recent answer (the gate awaiting a grant). */
  { fresh = false }: { fresh?: boolean } = {}
): Promise<{ token: string | null; definitive: boolean }> {
  const config = cloudAccount();
  // A missing desktop session says nothing about the cloud's installation.
  // Preserve existing provenance and let the runtime renew its own lease.
  if (!config?.deusCloudUrl || !config.sessionToken || !orgId)
    return { token: null, definitive: false };
  const slug = githubRepoSlug(originUrl);
  if (!slug) return { token: null, definitive: true };
  const { deusCloudUrl, sessionToken } = config;
  // Per signed-in session too: another account's answer is not this one's.
  const key = `${deusCloudUrl}\u0000${sessionToken}\u0000${orgId}\u0000${slug.toLowerCase()}`;
  return remembered(mints, key, fresh, () =>
    askForInstallationToken(deusCloudUrl, sessionToken, orgId, slug)
  );
}

async function askForInstallationToken(
  deusCloudUrl: string,
  sessionToken: string,
  orgId: string,
  slug: string
): Promise<{ answer: { token: string | null; definitive: boolean }; keep: boolean }> {
  const logKey = `${orgId}\u0000${slug.toLowerCase()}`;
  try {
    const res = await fetch(
      `${deusCloudUrl}/orgs/${encodeURIComponent(orgId)}/github/installation-token`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ repository: slug }),
        // This await sits on user-visible paths — before workspace creation
        // at provision time, and on the wake/send refresh — so an
        // unresponsive deus-cloud would otherwise stall them for undici's
        // 300s header timeout. Best-effort by design: giving up fast falls
        // back to the PAT path.
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      // The same refusal again (each caller, each focus) is logged once.
      if (loggedRefusals.get(logKey) !== res.status) {
        loggedRefusals.set(logKey, res.status);
        console.warn(`[CloudInit] GitHub App token mint unavailable (${res.status}) for ${slug}`);
      }
      // 404 is definitive ONLY when deus-cloud itself answered (its
      // AppError body is JSON: "No GitHub App installation for …"). A bare
      // routing 404 — GitHub routes not deployed yet, a worker fallthrough —
      // is a deployment skew, and stripping credentials on it would break a
      // working sandbox during a deploy mismatch.
      let definitive = res.status === 403;
      if (res.status === 404) {
        // Only deus-cloud's OWN answer is permission truth. Its AppError
        // serializes as { error: "NOT_FOUND", message: "No GitHub App
        // installation for <owner>", … } — a proxy/routing 404 (plain text,
        // {"error":"Not Found"}, null) must stay UNKNOWN, or a deployment
        // skew strips a working credential.
        const body = await res.text().catch(() => "");
        try {
          const parsed = JSON.parse(body) as { error?: unknown; message?: unknown } | null;
          definitive =
            parsed?.error === "NOT_FOUND" &&
            typeof parsed.message === "string" &&
            parsed.message.includes("GitHub App installation");
        } catch {
          definitive = false;
        }
      }
      return { answer: { token: null, definitive }, keep: true };
    }
    loggedRefusals.delete(logKey);
    const body = (await res.json()) as { token?: string };
    return {
      answer: { token: body.token ?? null, definitive: body.token ? true : false },
      keep: true,
    };
  } catch {
    return { answer: { token: null, definitive: false }, keep: false };
  }
}

/**
 * Is this GitHub repo public — i.e. cloneable by a tokenless sandbox?
 *
 * Unauthenticated GitHub API: a public repo answers 200, a private (or
 * missing) one answers 404 — GitHub hides private repos from anonymous
 * callers. We deliberately send NO credential so the answer reflects what the
 * *sandbox* (which has none) can reach, NOT what the user's local git creds
 * can. TRI-STATE: 200 -> public, 404 -> private (invisible to anon), anything
 * else (rate-limit — the anon limit is 60/hr PER IP, a shared quota on the
 * hosted backend — 5xx, network) -> null = "couldn't tell". The null case is
 * what stops a rate-limited probe from being read as "private" and wrongly
 * emitting needs_grant on a public repo.
 */
export function isPublicGithubRepo(
  slug: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<boolean | null> {
  return remembered(publicProbes, slug.toLowerCase(), fresh, async () => {
    try {
      const res = await fetch(githubApiUrl(`/repos/${slug}`), {
        headers: { accept: "application/vnd.github+json", "user-agent": "deus-machine" },
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
      if (res.status === 200) return { answer: true, keep: true };
      if (res.status === 404) return { answer: false, keep: true };
      return { answer: null, keep: false };
    } catch {
      return { answer: null, keep: false };
    }
  });
}

async function getGithub(
  path: string,
  token: string | null
): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(githubApiUrl(path), {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "deus-machine",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/**
 * The token reads use: the organization's installation token when one can be
 * minted for this repository, else none (a public repository answers without).
 */
async function readToken(slug: string, orgId: string | null): Promise<string | null> {
  const { token } = await mintRepoInstallationToken(`https://github.com/${slug}`, orgId);
  return token;
}

/** GitHub's default branch for `owner/name`; null when GitHub would not say (private, no access, offline). */
export async function defaultBranch(slug: string, orgId: string | null): Promise<string | null> {
  return defaultBranchWith(slug, await readToken(slug, orgId));
}

async function defaultBranchWith(slug: string, token: string | null): Promise<string | null> {
  const res = await getGithub(`/repos/${slug}`, token);
  const branch = (res?.body as { default_branch?: unknown } | null)?.default_branch;
  return typeof branch === "string" && branch ? branch : null;
}

/**
 * The repository's branches with the default one first, then the rest as
 * GitHub lists them, up to {@link BRANCH_LIST_CAP}. `defaultBranch` is null
 * when GitHub would not say; the list is then empty too.
 */
export async function branches(
  slug: string,
  orgId: string | null
): Promise<{ defaultBranch: string | null; branches: string[] }> {
  const token = await readToken(slug, orgId);
  const main = await defaultBranchWith(slug, token);
  if (!main) return { defaultBranch: null, branches: [] };
  const names: string[] = [main];
  for (let page = 1; names.length < BRANCH_LIST_CAP; page++) {
    const res = await getGithub(
      `/repos/${slug}/branches?per_page=${BRANCH_PAGE_SIZE}&page=${page}`,
      token
    );
    const list = Array.isArray(res?.body) ? (res.body as { name?: unknown }[]) : [];
    for (const branch of list) {
      if (typeof branch.name === "string" && branch.name !== main) names.push(branch.name);
    }
    if (list.length < BRANCH_PAGE_SIZE) break;
  }
  return { defaultBranch: main, branches: names.slice(0, BRANCH_LIST_CAP) };
}
