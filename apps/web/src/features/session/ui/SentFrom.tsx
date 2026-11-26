import type { ReportedOrigin } from "@shared/protocol-types";
import { cn } from "@/shared/lib/utils";
import { useSession } from "../api/session.queries";
import { chatReference } from "../lib/chatReference";
import { openChat } from "../lib/openChat";
import { useWorkspacesByRepo } from "@/features/workspace/api/workspace.queries";
import { useWorkspaceStore } from "@/features/workspace/store";

export function SentFrom({ origin }: { origin: ReportedOrigin }) {
  return <OriginCaption origin={origin} caption="Sent from" className="justify-end" />;
}

export function OriginCaption({
  origin,
  caption,
  className,
}: {
  origin: ReportedOrigin;
  caption: string;
  className?: string;
}) {
  // A newer engine's kind arrives intact: read only the fields this build knows, as strings.
  const name = "name" in origin && typeof origin.name === "string" ? origin.name : undefined;
  let source;
  if (origin.kind === "session" && typeof origin.sessionId === "string") {
    source = <ChatName sessionId={origin.sessionId} name={name} />;
  } else if (origin.kind === "assistant" && name) {
    source = (
      <span className="truncate" title={name}>
        {name}
      </span>
    );
  } else return null;
  return (
    <div className={cn("text-muted-foreground flex min-w-0 items-center gap-1 text-xs", className)}>
      <span className="shrink-0">{caption}</span> {source}
    </div>
  );
}

function ChatName({ sessionId, name }: { sessionId: string; name?: string }) {
  const { data: session } = useSession(sessionId);
  const { data: groups } = useWorkspacesByRepo();
  const selected = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const workspace = groups
    ?.flatMap((group) => group.workspaces)
    .find((w) => w.id === session?.workspace_id);
  const { label, canOpen } = chatReference(workspace, session, workspace?.id === selected, name);
  if (!canOpen || !workspace)
    return (
      <span className="truncate" title={label}>
        {label}
      </span>
    );
  return (
    <button
      type="button"
      title={label}
      onClick={() => openChat(workspace.id, sessionId)}
      className="bg-muted text-foreground hover:bg-accent max-w-64 truncate rounded-md px-1.5 py-0.5 transition-colors"
    >
      {label}
    </button>
  );
}
