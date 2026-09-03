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
