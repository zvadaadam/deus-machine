import { uiActions, type NewWorkspaceRequest } from "@/shared/stores/uiStore";
import { useWorkspaceStore } from "../store/workspaceStore";

/** What a composer asks for when nothing has been asked of a workspace yet. */
export const FIRST_MESSAGE_PLACEHOLDER = "Describe what you'd like to do...";

/**
 * The one way to start a workspace: go to Home, whose composer creates it
 * with the first message. A project to preselect and a draft to start from
 * are optional (a project's "+", a starter prompt, a message handed back).
 */
export function openNewWorkspace(request?: NewWorkspaceRequest): void {
  uiActions.requestNewWorkspace(request);
  useWorkspaceStore.getState().selectWorkspace(null);
}
