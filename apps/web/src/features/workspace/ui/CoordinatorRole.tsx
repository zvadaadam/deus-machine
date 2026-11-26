import { toast } from "sonner";
import { api } from "@shared/api";
import type { Workspace } from "@shared/types/workspace";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useCreateSession } from "@/features/session/api/session.queries";
import { openChat } from "@/features/session/lib/openChat";
import { showWorkspace } from "@/features/workspace/lib/openWorkspace";
import { getRuntimeClient } from "@/platform/ws";
import { getErrorMessage } from "@shared/lib/errors";
import { Network as CoordinatorIcon } from "lucide-react";

export function CoordinatorMark() {
  return (
    <span className="text-text-muted inline-flex shrink-0 items-center gap-1 text-xs">
      <CoordinatorIcon size={12} aria-hidden />
      Coordinator
    </span>
  );
}

export function MakeCoordinator({ workspace }: { workspace: Workspace }) {
  const createChat = useCreateSession();
  if (workspace.kind !== "worktree" || workspace.state !== "ready" || workspace.role) return null;
  async function promote() {
    const runtime = getRuntimeClient();
    try {
      await runtime.call(api.makeCoordinator, { workspaceId: workspace.id });
      if (runtime !== getRuntimeClient()) return;
      showWorkspace(workspace.id);
      toast("Now a coordinator. New chats here get its tools.", {
        action: {
          label: "New chat",
          onClick: async () => {
            if (runtime !== getRuntimeClient()) return;
            try {
              const chat = await createChat.mutateAsync(workspace.id);
              if (runtime === getRuntimeClient()) openChat(workspace.id, chat.id);
            } catch (error) {
              toast.error(getErrorMessage(error));
            }
          },
        },
      });
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }
  return (
    <ContextMenuItem onSelect={promote}>
      <CoordinatorIcon />
      Make coordinator
    </ContextMenuItem>
  );
}
