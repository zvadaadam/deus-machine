// backend/src/services/agent/cloud/models.ts
// What Deus Cloud runs, through @deus-hq/sdk's listModels() (GET /models).
//
// The platform serves the list because it follows the sandbox image, not the
// SDK this app ships: deus bundles no cloud list of its own. The list changes
// with a platform deploy, so a few minutes of staleness is harmless and keeps
// the automation editor and the create/update checks off the network. It is
// keyed by the cloud identity: an account switch reads it again.

import { listModels } from "@deus-hq/sdk";
import type { CloudModelList } from "@shared/cloud-models";
import { getCloudConfig, getCloudConnectionIdentity } from "./config";

const MODEL_LIST_TTL_MS = 5 * 60_000;
const MODEL_LIST_TIMEOUT_MS = 10_000;

let cached: { identity: string; fetchedAt: number; lists: CloudModelList[] } | null = null;
let inFlight: { identity: string; lists: Promise<CloudModelList[]> } | null = null;

/**
 * The platform's model lists, at most five minutes old. Null when no cloud
 * account is configured — there is no one to ask. A failed refresh serves the
 * same identity's previous lists (logged) rather than nothing; with none to
 * fall back on, it throws.
 */
export async function getCloudModelLists(): Promise<CloudModelList[] | null> {
  const config = getCloudConfig();
  if (!config) return null;
  const identity = getCloudConnectionIdentity();
  const previous = cached?.identity === identity ? cached : null;
  if (previous && Date.now() - previous.fetchedAt < MODEL_LIST_TTL_MS) return previous.lists;
  if (inFlight?.identity === identity) return inFlight.lists;

  const lists = listModels({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
  })
    .then((fresh) => {
      // An account switch while this was in flight: the answer is the old identity's.
      if (getCloudConnectionIdentity() === identity) {
        cached = { identity, fetchedAt: Date.now(), lists: fresh };
      }
      return fresh;
    })
    .catch((err: unknown) => {
      if (!previous) throw err;
      console.warn(`[CloudModels] model list refresh failed, serving the previous one: ${err}`);
      return previous.lists;
    })
    .finally(() => {
      if (inFlight?.lists === lists) inFlight = null;
    });
  inFlight = { identity, lists };
  return lists;
}

/** Test seam: forget the cached and in-flight lists. */
export function resetCloudModelListsForTests(): void {
  cached = null;
  inFlight = null;
}
