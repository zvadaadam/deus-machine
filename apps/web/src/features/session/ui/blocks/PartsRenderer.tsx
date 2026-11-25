import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Part, UnknownPart } from "@shared/protocol-types";
import type { TurnBlock } from "../../lib/assistantTurnContent";
import { extractChatResources } from "../../lib/chatResources";
import { useSession } from "../../context";
import { ActivityButton, TurnStatsHeader } from "../TurnStatsHeader";
import { PartBlock } from "./PartBlock";
import { ChatResourceCards } from "./ChatResourceCards";

interface PartsRendererProps {
  parts: Array<Part | UnknownPart>;
  rows: TurnBlock[];
  stays?: Set<string> | null;
  bubbles?: boolean;
  ended?: boolean;
  streaming?: boolean;
  workedLabel?: string;
}

export const PartsRenderer = memo(function PartsRenderer({
  parts,
  rows,
  stays,
  bubbles = false,
  streaming = false,
  ended,
  workedLabel,
}: PartsRendererProps) {
  const { workspacePath } = useSession();
  const id = useId();
  const worked = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
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
      {workedLabel && (
        <div className="fold-row" data-closed={mountedAll ? false : undefined}>
          <div className="min-h-0 overflow-clip">
            <ActivityButton
              buttonRef={worked}
              controls={id}
              expanded={open}
              onToggle={() => setOpen(!open)}
              label={workedLabel}
            />
          </div>
        </div>
      )}
      <div id={id}>
        {mounted.map((row) => {
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
                    isStreaming={streaming && row.id === rows.at(-1)?.id}
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
