/**
 * Stream-URL helpers for the cloud device screen — kept out of the component
 * file so fast refresh stays whole and the rules are unit-testable.
 */

/** The stream URL is a platform capability URL, embedded only over https and
 *  never from our own origin (see the sandbox note above). */
export function isEmbeddableStreamUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.origin !== window.location.origin;
  } catch {
    // Unparseable — or no window to compare against, which is no place to
    // embed anything either.
    return false;
  }
}

/** A short stable key for the URL: the manager id must change with the
 *  stream. `useWebview` adopts its instance during render, so a keyed remount
 *  on a new URL would otherwise adopt the OLD guest — and the old component's
 *  cleanup would then dispose the very instance the new one holds. */
export function streamKey(url: string): string {
  let hash = 5381;
  for (let i = 0; i < url.length; i++) hash = ((hash << 5) + hash + url.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
