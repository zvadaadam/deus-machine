/**
 * Workspace Tabs — polymorphic tab model for the right-side workspace pane.
 *
 * Every tab in the right pane is one variant of `WorkspaceTab`:
 * - Multi-instance: `new-tab`, `terminal`, local `browser`, `file`
 * - Singleton-preferring: `changes`, `files`, `simulator`, `config` (Agent), cloud `browser`
 */

import { match } from "ts-pattern";
import { deriveTitleFromUrl, isBlankUrl } from "@/features/browser/types";

/** Tool tabs available in the workspace pane (kept aligned with legacy ContentTab). */
export type ContentTab =
  | "changes"
  | "files"
  | "config"
  | "terminal"
  | "browser"
  | "simulator"
  | "device";

/** All tab kinds supported by the right-side browser-style tab bar. */
export type WorkspaceTabKind = "new-tab" | ContentTab | "file";

export type WorkspaceTab =
  | { id: string; kind: "new-tab" }
  | { id: string; kind: "changes" }
  | { id: string; kind: "files" }
  | { id: string; kind: "file"; path: string }
  | { id: string; kind: "terminal"; title: string }
  | {
      id: string;
      kind: "browser";
      url: string;
      title: string;
      isMobileView?: boolean;
      /** True for a cloud workspace's singleton sandbox preview tab (persists without a URL). */
      cloud?: boolean;
    }
  | { id: string; kind: "device" }
  | { id: string; kind: "simulator" }
  | { id: string; kind: "config" };

/**
 * Virtual default tab ID shown when a workspace has no saved tabs yet.
 * Avoids mutating the store on render while presenting a real New Tab canvas.
 */
export const DEFAULT_NEW_TAB_ID = "default-new-tab";

export const DEFAULT_NEW_TAB: WorkspaceTab = {
  id: DEFAULT_NEW_TAB_ID,
  kind: "new-tab",
};

export function createTabId(kind: WorkspaceTabKind, workspaceId?: string | null): string {
  const uuid = crypto.randomUUID();
  if (kind === "browser") {
    const prefix = workspaceId ? `ws-${workspaceId.slice(0, 8)}-browser` : "browser-tab";
    return `${prefix}-${uuid.slice(0, 12)}`;
  }
  return `${kind}-${uuid.slice(0, 12)}`;
}

export function createNewTab(): Extract<WorkspaceTab, { kind: "new-tab" }> {
  return { id: createTabId("new-tab"), kind: "new-tab" };
}

export function createFileTab(path: string): Extract<WorkspaceTab, { kind: "file" }> {
  return { id: createTabId("file"), kind: "file", path };
}

export function createTerminalTab(title: string): Extract<WorkspaceTab, { kind: "terminal" }> {
  return { id: createTabId("terminal"), kind: "terminal", title };
}

export function createBrowserTabItem(
  workspaceId: string | null | undefined,
  url = "",
  options?: { title?: string; cloud?: boolean; id?: string; isMobileView?: boolean }
): Extract<WorkspaceTab, { kind: "browser" }> {
  const cleanUrl = isBlankUrl(url) ? "" : url;
  return {
    id: options?.id ?? createTabId("browser", workspaceId),
    kind: "browser",
    url: cleanUrl,
    title: options?.title ?? (cleanUrl ? deriveTitleFromUrl(cleanUrl) : "Browser"),
    ...(options?.isMobileView ? { isMobileView: true } : {}),
    ...(options?.cloud ? { cloud: true } : {}),
  };
}

export function createToolTab(
  kind: ContentTab,
  workspaceId?: string | null,
  options?: { terminalTitle?: string; url?: string; cloud?: boolean }
): WorkspaceTab {
  return match(kind)
    .with("changes", () => ({ id: createTabId("changes"), kind: "changes" as const }))
    .with("files", () => ({ id: createTabId("files"), kind: "files" as const }))
    .with("config", () => ({ id: createTabId("config"), kind: "config" as const }))
    .with("device", () => ({ id: createTabId("device"), kind: "device" as const }))
    .with("simulator", () => ({ id: createTabId("simulator"), kind: "simulator" as const }))
    .with("terminal", () => createTerminalTab(options?.terminalTitle ?? "Terminal 1"))
    .with("browser", () =>
      createBrowserTabItem(workspaceId, options?.url ?? "", { cloud: options?.cloud })
    )
    .exhaustive();
}

/** Extract filename from a workspace-relative path. */
export function basenameOfPath(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
