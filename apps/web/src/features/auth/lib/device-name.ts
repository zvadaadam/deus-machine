/**
 * A readable name for a device from its browser, e.g. "iPhone · Safari" or
 * "Mac · Chrome". The Mac lists approved devices by this name. iPadOS Safari
 * reports a Mac user agent, so a touch screen tells an iPad apart.
 */
export function describeDevice(userAgent: string, options: { touch?: boolean } = {}): string {
  const ua = userAgent;
  const isMacUa = /Macintosh|Mac OS X/.test(ua);
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (isMacUa && options.touch)
      ? "iPad"
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? "Android phone"
          : "Android tablet"
        : isMacUa
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows PC"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux PC"
                : null;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /CriOS\/|Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  if (device && browser) return `${device} · ${browser}`;
  return device ?? browser ?? (/Mobile/.test(ua) ? "Mobile browser" : "Web browser");
}

/** Names earlier builds gave every device; a stored user agent can say more. */
const GENERIC_NAMES = new Set(["Web Browser", "Mobile Browser", "Unknown Device"]);

export function deviceDisplayName(device: { name: string; user_agent: string | null }): string {
  if (GENERIC_NAMES.has(device.name) && device.user_agent) return describeDevice(device.user_agent);
  return device.name;
}
