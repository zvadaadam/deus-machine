/**
 * The chat's composer, on a workspace that has no chat yet. Keyed by the
 * workspace (there is no session to key it by): what is typed here moves to
 * the first chat's composer when it opens (useFirstMessageDelivery).
 *
 * Sending makes the content the message that waits for the workspace. One
 * waits per workspace: while one does, the follow-up stays in the box until
 * the chat opens.
 */
import type { Workspace } from "@/shared/types";
import { DEFAULT_MODEL } from "@/shared/agents";
import { useDefaultThinkingLevel } from "@/features/settings/api";
import { FIRST_MESSAGE_PLACEHOLDER } from "@/features/workspace/lib/newWorkspace";
import {
  pendingFirstMessages,
  useWorkspaceStartStore,
} from "@/features/workspace/store/workspaceStartStore";
import { useSessionComposerStore } from "../store/sessionComposerStore";
import { ImageDropTarget } from "./ImageDropTarget";
import { MessageInput } from "./MessageInput";

export function WorkspaceStartComposer({ workspace }: { workspace: Workspace }) {
  const pending = useWorkspaceStartStore((state) => state.pending[workspace.id]);
  const defaultThinking = useDefaultThinkingLevel();

  const handleSend = (message: string) => {
    const composer = useSessionComposerStore.getState().composers[workspace.id];
    if (!composer || pendingFirstMessages.get(workspace.id)) return false;
    pendingFirstMessages.set(workspace.id, {
      message,
      model: composer.model,
      thinkingLevel: composer.thinkingLevel,
      planMode: composer.planModeEnabled,
    });
    return true;
  };

  return (
    <ImageDropTarget composerId={workspace.id}>
      <MessageInput
        sessionId={workspace.id}
        workspaceId={workspace.id}
        // No checkout yet: no files to list, and only the skills every project has.
        fileMentionsEnabled={false}
        workspacePath={null}
        workspaceKind={workspace.kind}
        // It opens with what the waiting message was sent with.
        initialModel={pending?.model ?? DEFAULT_MODEL}
        defaultThinking={pending?.thinkingLevel ?? defaultThinking}
        sending={false}
        // While a message waits, the agent the chat will have is decided.
        hasMessages={!!pending}
        environmentUnconfigured={false}
        placeholder={pending ? "Draft a follow-up…" : FIRST_MESSAGE_PLACEHOLDER}
        sendDisabledReason={pending ? "You can send this draft when the chat opens." : undefined}
        onSend={handleSend}
      />
    </ImageDropTarget>
  );
}
