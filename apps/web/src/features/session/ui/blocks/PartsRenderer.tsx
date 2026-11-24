import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Part, UnknownPart } from "@shared/protocol-types";
import { assistantTurnContent, staysAtEnd } from "../../lib/assistantTurnContent";
import { extractChatResources } from "../../lib/chatResources";
import { useSession } from "../../context";
import { ActivityButton, TurnStatsHeader } from "../TurnStatsHeader";
import { formatTurnDurationLabel } from "../utils/formatTurnDurationLabel";
import { PartBlock } from "./PartBlock";
import { ChatResourceCards } from "./ChatResourceCards";

interface PartsRendererProps {
  parts: Array<Part | UnknownPart>;
  bubbles?: boolean;
  ended?: boolean;
  agentMessages?: boolean;
  isStreamingTurn?: boolean;
  durationMs?: number | null;
}

export const PartsRenderer = memo(function PartsRenderer({
  parts,
  bubbles = false,
  ended = false,
  agentMessages,
  isStreamingTurn = false,
  durationMs,
}: PartsRendererProps) {
  const { workspacePath } = useSession();
  const id = useId();
  const [open, setOpen] = useState(false);
  const condensed = bubbles && !ended && !!agentMessages;
  const rows = useMemo(() => assistantTurnContent(parts, condensed), [parts, condensed]);
  const stays = useMemo(
    () => (bubbles && ended ? staysAtEnd(parts) : null),
    [parts, bubbles, ended]
  );
  const resources = useMemo(
    () =>
      extractChatResources({
        parts: parts.filter((part): part is Part => !("raw" in part)),
        isComplete: !isStreamingTurn,
        workspacePath,
      }),
    [parts, isStreamingTurn, workspacePath]
  );
  const visible = stays && !open ? rows.filter((row) => stays.has(row.id)) : rows;
  // A previously ended turn only needs its closed rows after the first expansion.
  // Once displayed (including while live or in Full run), keep their nodes.
  const mountedAll = useRef(false);
  useEffect(() => {
    if (!stays || open) mountedAll.current = true;
  }, [stays, open]);
  const mounted = mountedAll.current ? rows : visible;
  let nextVisible = 0;
  return (
    <>
      <div id={id}>
        {stays && stays.size < rows.length && (
          <div className="fold-row" data-closed={mountedAll.current ? false : undefined}>
            <div className="min-h-0 overflow-clip">
              <ActivityButton
                controls={id}
                expanded={open}
                onToggle={() => setOpen(!open)}
                label={
                  durationMs == null
                    ? "Worked"
                    : `Worked for ${formatTurnDurationLabel(durationMs)}`
                }
              />
            </div>
          </div>
        )}
        {mounted.map((row, i) => {
          const closed = !!stays && !open && !stays.has(row.id);
          const bubble =
            bubbles && row.type === "text"
              ? {
                  previous: !closed && visible[nextVisible - 1]?.type === "text",
                  next: !closed && visible[nextVisible + 1]?.type === "text",
                }
              : undefined;
          if (!closed) nextVisible++;
          return (
            <div
              key={row.id}
              className={`fold-row min-w-0 ${bubble ? "agent-words ml-[-12px]" : ""}`}
              data-closed={stays && (open || mountedAll.current) ? closed : undefined}
              {...(closed ? { inert: "" } : {})}
            >
              <div className="min-h-0 min-w-0 overflow-clip after:block after:h-1">
                {row.type === "activity" ? (
                  <TurnStatsHeader parts={row.parts} streaming={isStreamingTurn} />
                ) : (
                  <PartBlock
                    part={row}
                    bubble={bubble}
                    isStreaming={isStreamingTurn && i === rows.length - 1}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <ChatResourceCards resources={resources} />
    </>
  );
});
