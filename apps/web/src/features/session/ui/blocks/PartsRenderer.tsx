import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  streaming?: boolean;
  durationMs?: number | null;
}

export const PartsRenderer = memo(function PartsRenderer({
  parts,
  bubbles = false,
  streaming = false,
  ended,
  agentMessages,
  durationMs,
}: PartsRendererProps) {
  const { workspacePath } = useSession();
  const id = useId();
  const worked = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const condensed = bubbles && !ended && !!agentMessages;
  const rows = useMemo(() => assistantTurnContent(parts, condensed), [parts, condensed]);
  const stays = useMemo(() => (ended ? staysAtEnd(parts) : null), [parts, ended]);
  const visibleIds = bubbles && !open ? stays : null;
  const resources = useMemo(
    () =>
      extractChatResources({
        parts: parts.filter((part): part is Part => !("raw" in part)),
        isComplete: !streaming,
        workspacePath,
      }),
    [parts, streaming, workspacePath]
  );
  const visible = visibleIds ? rows.filter((row) => visibleIds.has(row.id)) : rows;
  // A previously ended turn only needs its closed rows after the first expansion.
  // Once displayed (including while live or in Full run), keep their nodes.
  const [mountedAll, setMountedAll] = useState(!visibleIds);
  if (!mountedAll && !visibleIds) setMountedAll(true);
  const mounted = mountedAll ? rows : visible;
  useLayoutEffect(() => {
    if (!visibleIds) return;
    const row = document.activeElement?.closest("[inert]");
    if (row && document.getElementById(id)?.contains(row)) {
      worked.current?.focus({ preventScroll: true });
    }
  }, [visibleIds, id]);
  let nextVisible = 0;
  return (
    <>
      {bubbles && stays && stays.size < rows.length && (
        <div className="fold-row" data-closed={mountedAll ? false : undefined}>
          <div className="min-h-0 overflow-clip">
            <ActivityButton
              buttonRef={worked}
              controls={id}
              expanded={open}
              onToggle={() => setOpen(!open)}
              label={
                durationMs == null ? "Worked" : `Worked for ${formatTurnDurationLabel(durationMs)}`
              }
            />
          </div>
        </div>
      )}
      <div id={id}>
        {mounted.map((row, i) => {
          const kept = stays?.has(row.id);
          const closed = !!visibleIds && !kept;
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
              className={`fold-row min-w-0 ${bubble ? "agent-words -ml-1" : ""}`}
              aria-live={kept === false ? "off" : undefined}
              data-closed={bubbles && ended && mountedAll ? closed : undefined}
              {...(closed ? { inert: "" } : {})}
            >
              <div className="min-h-0 min-w-0 overflow-clip after:block after:h-1">
                {row.type === "typing" ? (
                  <p role="status" className="text-muted-foreground px-2 py-1.5 text-sm">
                    Typing…
                  </p>
                ) : row.type === "activity" ? (
                  <TurnStatsHeader parts={row.parts} streaming={ended === false} />
                ) : (
                  <PartBlock
                    part={row}
                    bubble={bubble}
                    isStreaming={streaming && i === rows.length - 1}
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
