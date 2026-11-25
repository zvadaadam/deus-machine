import { memo, useMemo, type ReactElement } from "react";
import type { Message, SessionTurn } from "@/shared/types";
import type { ChatView } from "@/features/settings/lib/chatView";
import { getTurnFooterData } from "./utils";
import { turnStopNotice } from "../lib/chatTimeline";
import { assistantTurnContent, staysAtEnd } from "../lib/assistantTurnContent";
import { formatTurnDurationLabel } from "./utils/formatTurnDurationLabel";
import { PartsRenderer } from "./blocks/PartsRenderer";
import { AnimatePresence } from "framer-motion";
import { Collapse } from "@/components/ui/collapse";
import { TurnFooter, TurnFooterSlot } from "./TurnFooter";
import { Square, TriangleAlert } from "lucide-react";

interface AssistantTurnProps {
  rowId: string;
  onOpenWorked?: () => void;
  view: ChatView;
  messages: Message[];
  turn?: SessionTurn;
  footerGroups?: Message[][];
  ended: boolean;
  streaming: boolean;
  agentMessages?: boolean;
  /** The current reply keeps its slot when a disconnect or error clears progress before its end. */
  progressSlot?: ReactElement;
  startedAt?: string | null;
}

export const AssistantTurn = memo(function AssistantTurn({
  rowId,
  onOpenWorked,
  messages,
  view,
  turn,
  footerGroups,
  ended,
  streaming,
  agentMessages,
  progressSlot,
  startedAt,
}: AssistantTurnProps) {
  const parts = useMemo(() => messages.flatMap((message) => message.parts ?? []), [messages]);
  const footer = useMemo(
    () => footerGroups && getTurnFooterData(footerGroups, startedAt, turn),
    [footerGroups, startedAt, turn]
  );
  const bubbles = view === "bubbles";
  const condensed = bubbles && !ended && !!agentMessages;
  const rows = useMemo(() => assistantTurnContent(parts, condensed), [parts, condensed]);
  const stays = useMemo(() => (ended ? staysAtEnd(parts) : null), [parts, ended]);
  const hasWorkedLine = bubbles && stays && stays.size < rows.length;
  const workedTime =
    hasWorkedLine && footerGroups?.length === 1 && footer?.durationMs != null
      ? formatTurnDurationLabel(footer.durationMs)
      : null;
  const workedLabel = workedTime ? `Worked for ${workedTime}` : "Worked";
  const cancelled = turn?.stopReason === "cancelled";
  const notice = cancelled ? "Response stopped" : turnStopNotice(turn?.stopReason);
  const NoticeIcon = cancelled ? Square : TriangleAlert;
  return (
    <div
      className="assistant-turn flex w-full min-w-0 flex-col"
      style={{ contain: "layout style" }}
    >
      <PartsRenderer
        rowId={rowId}
        onOpenWorked={onOpenWorked}
        parts={parts}
        rows={rows}
        stays={stays}
        bubbles={bubbles}
        ended={ended}
        streaming={streaming}
        workedLabel={hasWorkedLine ? workedLabel : undefined}
      />
      <AnimatePresence initial={false}>
        {footer && notice && (
          <Collapse key="notice">
            <div className="border-warning/20 border-l-warning bg-warning/5 mx-2 flex items-center gap-2.5 rounded-lg border border-l-2 px-3 py-2">
              <NoticeIcon
                className={`text-warning/60 size-3.5 shrink-0 ${cancelled ? "fill-current" : ""}`}
              />
              <span className="text-warning text-sm font-medium">{notice}</span>
            </div>
          </Collapse>
        )}
      </AnimatePresence>
      {footer ? (
        <TurnFooterSlot>
          <TurnFooter {...footer} workedTime={workedTime} />
        </TurnFooterSlot>
      ) : (
        progressSlot
      )}
    </div>
  );
});
