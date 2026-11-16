/**
 * Carries out rule 2 (features/workspace/lib/reach.ts) for the chat: the
 * links in a reply and the actions on its resource cards. The rule decides;
 * this only does what it said.
 */
import { match } from "ts-pattern";
import { toast } from "sonner";
import { api } from "@shared/api";
import { call, getRuntimeClient } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Settings } from "@shared/types/settings";
import { native } from "@/platform/native";
import { getBaseURL } from "@/shared/config/api.config";
import { isMobileViewport } from "@/shared/hooks/use-mobile";
import { isTabVisible, tabsFor } from "@/app/layouts/content-tabs";
import { browserWindowActions } from "@/features/browser/store/browserWindowStore";
import {
  cloudPreviewActions,
  useCloudPreviewStore,
} from "@/features/browser/cloud/cloudPreviewStore";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import {
  openAddress,
  openFile,
  type ChatOpening,
  type ChatPlace,
} from "@/features/workspace/lib/reach";
import { createWorkspacePreviewUrl, type ChatResource, type ResourceAction } from "./chatResources";

/** The opening a resource card's action stands for. */
export function openingOf(action: ResourceAction, place: ChatPlace): ChatOpening {
  return match(action)
    .with({ kind: "deus-browser" }, ({ url }) => openAddress(url, place))
    .with({ kind: "system-browser" }, ({ url }) => openAddress(url, place, true))
    .with({ kind: "deus-browser-file" }, ({ path }) => openFile(path, place, "preview"))
    .with({ kind: "deus-file" }, ({ path, target }) => openFile(path, place, target))
    .with({ kind: "system-file" }, ({ path }) => openFile(path, place, "default-app"))
    .with({ kind: "finder" }, ({ path }) => openFile(path, place, "finder"))
    .exhaustive();
}

/**
 * A card's actions in this chat: only those rule 2 can carry out here (no
 * Finder or default app without a folder on this computer), without two that
 * do the same thing. The first one left is the card's button.
 */
export function offeredActions(resource: ChatResource, place: ChatPlace): ResourceAction[] {
  const seen = new Set<string>();
  return [resource.primaryAction, ...resource.secondaryActions].filter((action) => {
    const opening = openingOf(action, place);
    if (opening.to === "none") return false;
    // Without the click's place (no preview address yet) two addresses may both
    // read "say": they are still two actions.
    if (opening.to === "say") return true;
    const key = JSON.stringify(opening);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where the chat is, as rule 2 reads it at the moment of a click: for a local
 * workspace, whether this client has a Browser tab; for a cloud workspace, the
 * computer's preview address (asked once if this window has not heard it) and
 * whether this window shows the preview.
 */
export async function chatPlaceNow(
  workspaceId: string,
  place: Pick<ChatPlace, "cloud" | "folder">
): Promise<ChatPlace> {
  if (!place.cloud) {
    // This client's Browser tab, as the tab bar decides it (`tabsFor`).
    const settings = getRuntimeClient().queryClient.getQueryData<Settings>(queryKeys.settings.all);
    const browserTab =
      !isMobileViewport() && isTabVisible("browser", settings, tabsFor({ kind: "worktree" }));
    return { ...place, browserTab };
  }
  let template = useCloudPreviewStore.getState().byWorkspace[workspaceId];
  if (template === undefined) {
    template = (await call(api.cloudPreview, { workspaceId }).catch(() => null)) ?? null;
  }
  const previewTab =
    !isMobileViewport() && isTabVisible("browser", undefined, tabsFor({ kind: "cloud" }));
  return { ...place, previewTemplate: template, previewTab };
}

function showInBrowserTab(workspaceId: string, url: string): void {
  workspaceLayoutActions.openContentTab(workspaceId, "browser");
  browserWindowActions.requestNewTab(workspaceId, url);
}

export async function openFromChat(workspaceId: string, opening: ChatOpening): Promise<void> {
  await match(opening)
    .with({ to: "browser-tab" }, ({ url }) => showInBrowserTab(workspaceId, url))
    .with({ to: "cloud-preview" }, ({ port, url }) => {
      cloudPreviewActions.show(workspaceId, port, url);
      workspaceLayoutActions.openContentTab(workspaceId, "browser");
    })
    .with({ to: "external" }, ({ url }) => native.window.openExternal(url))
    .with({ to: "file-preview" }, async ({ path }) => {
      try {
        showInBrowserTab(
          workspaceId,
          createWorkspacePreviewUrl(await getBaseURL(), workspaceId, path)
        );
      } catch (error) {
        console.warn("[chat] Failed to open file preview:", error);
      }
    })
    .with({ to: "files" }, ({ path, target }) =>
      workspaceLayoutActions.openFileInContent(workspaceId, path, target)
    )
    .with({ to: "default-app" }, ({ path }) =>
      native.files.openPath({ workspaceId, relativePath: path })
    )
    .with({ to: "finder" }, ({ path }) =>
      native.files.revealInFinder({ workspaceId, relativePath: path })
    )
    .with({ to: "say" }, ({ message }) => {
      toast(message);
    })
    .with({ to: "none" }, () => {})
    .exhaustive();
}
