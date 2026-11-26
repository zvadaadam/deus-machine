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

/**
 * The EAS preview reads `?embed=1` (the value must be exactly "1") as
 * presentation mode with its own chrome LOCKED off: no viewer toolbar, no
 * "live" pill, no expand/split/sidebar buttons — just the device. Deus draws
 * its own frame and Start/Home/Screenshot header around it, so embedding the
 * whole viewer UI would double every control. A malformed URL is returned
 * untouched (isEmbeddableStreamUrl already rejected it upstream).
 */
export function toEmbeddedStreamUrl(streamUrl: string): string {
  try {
    const url = new URL(streamUrl);
    url.searchParams.set("embed", "1");
    return url.toString();
  } catch {
    return streamUrl;
  }
}
