/**
 * Canonical JSON for q: wire parameters: property order must not create another
 * subscription here, nor another read in the backend query engine.
 */
export function subscriptionKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
  });
}
