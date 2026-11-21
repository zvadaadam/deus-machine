import type { ReportedOrigin } from "@shared/protocol-types";
import { cn } from "@/shared/lib/utils";
import { useSession } from "../api/session.queries";
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
  const { kind, name, sessionId } = origin as { kind: string; name?: unknown; sessionId?: unknown };
  const named = typeof name === "string" ? name : undefined;
  let source;
  if (kind === "session" && typeof sessionId === "string") {
    source = <ChatName sessionId={sessionId} name={named} />;
  } else if (kind === "assistant" && named) {
    source = (
      <span className="truncate" title={named}>
        {named}
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
  const title = session?.title || name || "another chat";
  const place = workspace && workspace.id !== selected ? workspace.title || workspace.slug : null;
  // A workspace named as its chat (its first, titled alike) is said once.
  const label = place && place !== title ? `${place} · ${title}` : title;
  // A sender put away (its chat or its workspace archived) or gone is named, not linked.
  if (!workspace || !session || session.is_hidden)
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
