import type { Session } from "@shared/types/session";
import type { Workspace } from "@shared/types/workspace";
import { getWorkspaceDisplayName } from "@/features/sidebar/lib/utils";

/** The name a person sees and whether the referenced chat can be opened. */
export function chatReference(
  workspace: Workspace | undefined,
  chat: Pick<Session, "title" | "is_hidden"> | null | undefined,
  here: boolean,
  fallback?: string
) {
  const place = workspace && getWorkspaceDisplayName(workspace);
  const name = chat?.title || fallback || place || "another chat";
  return {
    label: place && !here && place !== name ? `${place} · ${name}` : name,
    canOpen: !!workspace && workspace.state !== "archived" && !!chat && !chat.is_hidden,
  };
}
