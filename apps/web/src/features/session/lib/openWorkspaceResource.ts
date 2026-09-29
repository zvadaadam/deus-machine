import {
  workspaceLayoutActions,
  type FileNavigationTarget,
} from "@/features/workspace/store/workspaceLayoutStore";
import { browserWindowActions } from "@/features/browser/store/browserWindowStore";
import { capabilities } from "@/platform/capabilities";
import { native } from "@/platform";
import { toast } from "sonner";
import { getErrorMessage } from "@shared/lib/errors";

export type WorkspaceResource =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string; target: FileNavigationTarget };

/** Return whether the resource opened in a workspace pane that its host should reveal. */
export function openWorkspaceResource(
  workspaceId: string,
  resource: WorkspaceResource,
  browserAvailable = capabilities.nativeBrowser
): boolean {
  if (resource.kind === "url") {
    if (!browserAvailable) {
      void native.window
        .openExternal(resource.url)
        .catch((error) => toast.error(getErrorMessage(error)));
      return false;
    }
    workspaceLayoutActions.openContentTab(workspaceId, "browser");
    browserWindowActions.requestNewTab(workspaceId, resource.url);
  } else {
    workspaceLayoutActions.openFileInContent(workspaceId, resource.path, resource.target);
  }
  return true;
}
