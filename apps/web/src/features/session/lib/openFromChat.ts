/**
 * Carries out rule 2 (features/workspace/lib/reach.ts) for chat links, resource
 * cards and addresses entered in New Tab.
 */
import { match } from "ts-pattern";
import { toast } from "sonner";
import { api } from "@shared/api";
import { call, getRuntimeClient } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Settings } from "@shared/types/settings";
import { native } from "@/platform/native";
import { capabilities } from "@/platform/capabilities";
import { readFileUrl } from "@/features/file-browser/api/fileUrl";
import { getErrorMessage } from "@shared/lib/errors";
import { isMobileViewport } from "@/shared/hooks/use-mobile";
import { isTabVisible, tabsFor } from "@/features/workspace-tabs/registry";
import {
  cloudPreviewActions,
  useCloudPreviewStore,
} from "@/features/browser/cloud/cloudPreviewStore";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import {
  needsPreviewAddress,
  openAddress,
  openFile,
  type ChatOpening,
  type ChatPlace,
} from "@/features/workspace/lib/reach";
import type { ChatResource, ResourceAction } from "./chatResources";

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
 * Where the chat is, as rule 2 reads it at the moment of a click, with no
 * request: for a local workspace, whether this client has a Browser tab; for a
 * cloud workspace, the computer's preview address as this window last heard it
 * (`undefined` when it has not) and whether this window shows the preview.
 */
export function chatPlaceNow(
  workspaceId: string,
  place: Pick<ChatPlace, "cloud" | "folder">
): ChatPlace {
  if (!place.cloud) {
    // This client's Browser tab, as the tab bar decides it (`tabsFor`).
    const settings = getRuntimeClient().queryClient.getQueryData<Settings>(queryKeys.settings.all);
    const browserTab =
      !isMobileViewport() && isTabVisible("browser", settings, tabsFor({ kind: "worktree" }));
    return { ...place, browserTab };
  }
  const previewTab =
    !isMobileViewport() && isTabVisible("browser", undefined, tabsFor({ kind: "cloud" }));
  return {
    ...place,
    previewTemplate: useCloudPreviewStore.getState().byWorkspace[workspaceId],
    previewTab,
  };
}

/**
 * A browser allows a new tab during the original gesture. If an external action
 * must first ask for the cloud computer's preview address, reserve that tab now.
 */
export async function openAddressFromChat(
  workspaceId: string,
  url: string,
  base: Pick<ChatPlace, "cloud" | "folder">,
  { external = false, replaceTabId }: { external?: boolean; replaceTabId?: string } = {}
) {
  const place = chatPlaceNow(workspaceId, base);
  const needsTemplate = place.previewTemplate === undefined && needsPreviewAddress(url, place);
  const tab = needsTemplate && external ? native.window.openExternalPending() : null;
  if (needsTemplate) {
    place.previewTemplate =
      (await call(api.cloudPreview, { workspaceId }).catch(() => null)) ?? null;
  }
  const opening = openAddress(url, place, external);
  if (tab && opening.to === "external") {
    await tab.open(opening.url);
  } else {
    tab?.cancel();
    await openFromChat(workspaceId, opening, replaceTabId);
  }
  return opening.to;
}

/** A resource card's action, carried out from the click (addresses as `openAddressFromChat`). */
export async function runChatAction(
  workspaceId: string,
  action: ResourceAction,
  base: Pick<ChatPlace, "cloud" | "folder">
): Promise<void> {
  if (action.kind === "deus-browser" || action.kind === "system-browser") {
    await openAddressFromChat(workspaceId, action.url, base, {
      external: action.kind === "system-browser",
    });
    return;
  }
  await openFromChat(workspaceId, openingOf(action, chatPlaceNow(workspaceId, base)));
}

export async function openFromChat(
  workspaceId: string,
  opening: ChatOpening,
  replaceTabId?: string
): Promise<void> {
  await match(opening)
    .with({ to: "browser-tab" }, ({ url }) =>
      workspaceLayoutActions.openBrowserTab(workspaceId, url, { replaceTabId })
    )
    .with({ to: "cloud-preview" }, ({ port, rest }) => {
      cloudPreviewActions.show(workspaceId, port, rest);
      workspaceLayoutActions.openBrowserTab(workspaceId, "", { cloud: true, replaceTabId });
    })
    .with({ to: "external" }, ({ url }) => native.window.openExternal(url))
    .with({ to: "file-preview" }, async ({ path }) => {
      const tab = capabilities.nativeBrowser ? null : native.window.openExternalPending();
      try {
        const url = await readFileUrl(["preview", path, workspaceId]);
        if (tab) await tab.open(url);
        else workspaceLayoutActions.openBrowserTab(workspaceId, url);
      } catch (error) {
        tab?.cancel();
        toast.error(getErrorMessage(error));
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
