/**
 * Who sent a user message, when it was not the person: "Sent from" and the
 * sending chat, which opens it (its title, its workspace's name in front when
 * it is another workspace), or "Sent from <assistant>". The person's own
 * messages, and a sender this build does not know, show nothing.
 */

import type { ReportedOrigin } from "@shared/protocol-types";
import { useSession } from "../api/session.queries";
import { openChat } from "../lib/openChat";
import { useWorkspacesByRepo } from "@/features/workspace/api/workspace.queries";
import { useWorkspaceStore } from "@/features/workspace/store";

const CAPTION = "text-muted-foreground flex items-center justify-end gap-1 text-xs";

export function SentFrom({ origin }: { origin: ReportedOrigin }) {
  // A newer engine's kind arrives intact: read only the fields this build knows, as strings.
  const { kind, name, sessionId } = origin as { kind: string; name?: unknown; sessionId?: unknown };
  const named = typeof name === "string" ? name : undefined;
  if (kind === "assistant" && named) return <div className={CAPTION}>Sent from {named}</div>;
  if (kind !== "session" || typeof sessionId !== "string") return null;
  return <SentFromChat sessionId={sessionId} name={named} />;
}

function SentFromChat({ sessionId, name }: { sessionId: string; name?: string }) {
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
    return <div className={CAPTION}>Sent from {label}</div>;
  return (
    <div className={CAPTION}>
      Sent from
      <button
        type="button"
        onClick={() => openChat(workspace.id, sessionId)}
        className="bg-muted text-foreground hover:bg-accent max-w-64 truncate rounded-md px-1.5 py-0.5 transition-colors duration-200"
      >
        {label}
      </button>
    </div>
  );
}
