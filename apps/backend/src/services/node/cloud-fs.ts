/**
 * Cloud fs tree cache — the sandbox fs channel with its single-flight + TTL +
 * identity-generation caching, lifted out of routes/files.ts so the
 * RemoteNodeDriver owns it (see driver.ts). Behavior is unchanged;
 * cloud-files.test.ts pins the coalescing and cross-account invalidation.
 */
import { requestCloudFs, getCloudIdentityGeneration } from "../agent/cloud/driver";
import { ValidationError } from "../../lib/errors";

/** The sandbox fs channel's node shape (mapped to the local tree shape below). */
export interface CloudFsNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: CloudFsNode[];
}

/** Cloud fs failures are USER states (asleep computer, provisioning, timeouts)
 *  — mapped here so they surface as instructions, never "Internal server
 *  error" + a spurious error report. */
export async function cloudFsOrThrow(
  sessionId: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    return await requestCloudFs(sessionId, request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      /timed out/.test(message)
        ? "Sandbox did not answer — it may be waking; try again shortly."
        : message
    );
  }
}

/** Search/@-mentions must see the WHOLE repo, not a 5k-truncated prefix — a
 *  higher list bound for the cloud lane (still bounded so a giant monorepo
 *  can't DoS the channel). */
const CLOUD_LIST_CAP = 50_000;
const CLOUD_TREE_TTL_MS = 15_000;
/** Bound the per-session tree cache; oldest entry is evicted past this. */
const CLOUD_TREE_CACHE_MAX = 16;

type CloudList = { tree: CloudFsNode[]; truncated: boolean };
type CloudCacheEntry = { promise: Promise<CloudList>; expiresAt: number; identityGen: number };

/** One cached fs.list per session, keyed by the (settling) PROMISE rather than
 *  its result, so a single structure does double duty: concurrent @-mention
 *  keystrokes that land mid-flight await the SAME up-to-50k round-trip instead
 *  of each firing their own, and repeat reads within the TTL await an
 *  already-settled promise for free. Failures are never cached. Entries are
 *  stamped with the cloud identity generation: a sign-out/account switch bumps
 *  it, so account B never reads account A's still-cached paths. */
const cloudTreeCache = new Map<string, CloudCacheEntry>();

export function listCloudTree(sessionId: string): Promise<CloudList> {
  const identityGen = getCloudIdentityGeneration();
  const hit = cloudTreeCache.get(sessionId);
  if (hit && hit.identityGen === identityGen && hit.expiresAt > Date.now()) return hit.promise;
  const promise = (async (): Promise<CloudList> => {
    const data = (await cloudFsOrThrow(sessionId, {
      op: "list",
      maxEntries: CLOUD_LIST_CAP,
    })) as { tree?: CloudFsNode[]; truncated?: boolean; error?: string };
    if (data.error) throw new ValidationError(data.error);
    return { tree: data.tree ?? [], truncated: data.truncated === true };
  })();
  // In-flight entries carry expiresAt = Infinity so they're always reusable —
  // the TTL only starts once the (up to 50k) list SETTLES. Otherwise a list
  // slower than the TTL would read as "expired" mid-flight and every keystroke
  // would kick off its own full re-list. The `=== entry` guards keep a later
  // refresh / identity change from having its entry clobbered by this one.
  const entry: CloudCacheEntry = { promise, expiresAt: Infinity, identityGen };
  promise.then(
    () => {
      if (cloudTreeCache.get(sessionId) === entry) entry.expiresAt = Date.now() + CLOUD_TREE_TTL_MS;
    },
    () => {
      if (cloudTreeCache.get(sessionId) === entry) cloudTreeCache.delete(sessionId); // never cache a failure
    }
  );
  cloudTreeCache.set(sessionId, entry);
  if (cloudTreeCache.size > CLOUD_TREE_CACHE_MAX) {
    const oldest = cloudTreeCache.keys().next().value;
    if (oldest && oldest !== sessionId) cloudTreeCache.delete(oldest);
  }
  return promise;
}

/** Drop a session's cached tree — an in-flight one too, so a refresh can't be
 *  clobbered by the list it raced. */
export function invalidateCloudTree(sessionId: string): void {
  cloudTreeCache.delete(sessionId);
}

export function flattenCloudTree(tree: CloudFsNode[]): string[] {
  const paths: string[] = [];
  const walk = (nodes: CloudFsNode[]) => {
    for (const node of nodes) {
      if (node.type === "file") paths.push(node.path);
      else if (node.children) walk(node.children);
    }
  };
  walk(tree);
  return paths;
}

/** Map the sandbox fs-channel tree onto the local file-tree response shape. */
export function cloudTreeToResponse(tree: CloudFsNode[]) {
  let totalFiles = 0;
  let totalSize = 0;
  const map = (node: CloudFsNode): Record<string, unknown> => {
    if (node.type === "file") {
      totalFiles += 1;
      totalSize += node.size ?? 0;
      return { name: node.name, path: node.path, type: "file", size: node.size };
    }
    return {
      name: node.name,
      path: node.path,
      type: "directory",
      children: (node.children ?? []).map(map),
    };
  };
  const files = tree.map(map);
  return { files, totalFiles, totalSize };
}
