/** Well-known iOS app bundle IDs so you can `.app('Maps')` instead of a full bundle ID. */
const KNOWN_APPS: Record<string, string> = {
  Calendar: "com.apple.mobilecal",
  Camera: "com.apple.camera",
  Clock: "com.apple.mobiletimer",
  Contacts: "com.apple.MobileAddressBook",
  FaceTime: "com.apple.facetime",
  Files: "com.apple.DocumentsApp",
  Health: "com.apple.Health",
  Mail: "com.apple.mobilemail",
  Maps: "com.apple.Maps",
  Messages: "com.apple.MobileSMS",
  Music: "com.apple.Music",
  News: "com.apple.news",
  Notes: "com.apple.mobilenotes",
  Phone: "com.apple.mobilephone",
  Photos: "com.apple.Photos",
  Podcasts: "com.apple.podcasts",
  Reminders: "com.apple.reminders",
  Safari: "com.apple.mobilesafari",
  Settings: "com.apple.Preferences",
  Shortcuts: "com.apple.shortcuts",
  Stocks: "com.apple.stocks",
  Tips: "com.apple.tips",
  Translate: "com.apple.Translate",
  TV: "com.apple.tv",
  Voice: "com.apple.VoiceMemos",
  Wallet: "com.apple.Passbook",
  Watch: "com.apple.Bridge",
  Weather: "com.apple.weather",
};

/** Resolve an app name to a bundle ID. Returns input unchanged if it looks like a bundle ID. */
export function resolveBundleId(nameOrBundleId: string): string {
  if (nameOrBundleId.includes(".")) return nameOrBundleId;

  const bundleId = KNOWN_APPS[nameOrBundleId];
  if (!bundleId) {
    throw new Error(
      `Unknown app "${nameOrBundleId}". Use a bundle ID (e.g. "com.example.app") or one of: ${Object.keys(KNOWN_APPS).join(", ")}`
    );
  }
  return bundleId;
}
