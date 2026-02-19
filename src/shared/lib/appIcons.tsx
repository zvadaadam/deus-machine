/**
 * App icon utilities — fallback and categorization for installed applications.
 *
 * Real app icons are extracted from macOS by Rust (src-tauri/src/commands/apps.rs)
 * via PlistBuddy + sips → base64 PNG data URLs. The frontend renders <img src={app.icon}>
 * when available. AppIcon below is the generic fallback for the rare case where
 * Rust extraction fails (non-standard bundle, missing .icns, sips error).
 */

import { cn } from "@/shared/lib/utils";

/**
 * Generic fallback icon — renders app's first letter in a muted rounded square.
 * Used only when native macOS icon extraction fails (app.icon is null/undefined).
 */
export function AppIcon({
  appId,
  className,
}: {
  appId: string;
  className?: string;
}) {
  const initial = appId.charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        "bg-muted text-muted-foreground inline-flex items-center justify-center rounded-[3px] text-[9px] font-semibold",
        className,
      )}
    >
      {initial}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App categorization — used to group items in dropdowns
// ---------------------------------------------------------------------------

type AppCategory = "editor" | "terminal" | "system";

const TERMINAL_IDS = new Set(["terminal", "iterm", "warp"]);
const SYSTEM_IDS = new Set(["finder"]);

export function getAppCategory(appId: string): AppCategory {
  if (TERMINAL_IDS.has(appId)) return "terminal";
  if (SYSTEM_IDS.has(appId)) return "system";
  return "editor";
}

/**
 * Groups a flat list of apps into ordered categories for display.
 * Returns: editors first, then terminals, then system utilities.
 */
export function groupAppsByCategory<T extends { id: string }>(
  apps: T[]
): { category: AppCategory; apps: T[] }[] {
  const editors: T[] = [];
  const terminals: T[] = [];
  const system: T[] = [];

  for (const app of apps) {
    const cat = getAppCategory(app.id);
    if (cat === "editor") editors.push(app);
    else if (cat === "terminal") terminals.push(app);
    else system.push(app);
  }

  const groups: { category: AppCategory; apps: T[] }[] = [];
  if (editors.length > 0) groups.push({ category: "editor", apps: editors });
  if (terminals.length > 0) groups.push({ category: "terminal", apps: terminals });
  if (system.length > 0) groups.push({ category: "system", apps: system });
  return groups;
}
