import { useState } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, useIsPresent } from "framer-motion";
import { ArrowUp, GripVertical, Image, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@shared/api";
import type { QueuedMessages } from "@shared/api/sessions";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { call } from "@/platform/ws";
import { useReorderSensors } from "@/shared/hooks/useReorderSensors";
import { tempo } from "@/shared/lib/tempo";
import { cn } from "@/shared/lib/utils";
import { useQueuedMessages } from "../api/session.queries";
import { hasLimitReset, limitTime } from "../lib/queuedMessages";
import { SentFrom } from "./SentFrom";

type Row = QueuedMessages["items"][number];
type Move = { id: string; before: string | null };

function showError(error: unknown) {
  toast.error(getErrorMessage(error));
}

function ImageCount({ count, besideText }: { count: number; besideText: boolean }) {
  const label = `${count} ${count === 1 ? "image" : "images"}`;
  if (!besideText) return <span className="shrink-0">{label}</span>;
  return (
    <span
      role="img"
      aria-label={label}
      className="text-text-muted inline-flex shrink-0 items-center gap-0.5 text-xs"
    >
      <Image aria-hidden="true" className="size-3" />
      {count}
    </span>
  );
}

interface QueueControls {
  sessionId: string;
  turnId?: string;
  canSteer: boolean;
  editDisabled: boolean;
  onEdit: (id: string) => Promise<void>;
}

function QueuedRow({
  row: { id, text, images, state, origin, reason },
  moving,
  sessionId,
  turnId,
  canSteer,
  editDisabled,
  onEdit,
}: QueueControls & { row: Row; moving: boolean }) {
  const waiting = state === "waiting";
  const present = useIsPresent();
  const sortable = waiting && present;
  const duration = tempo.moderate.duration * 1000;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    index,
  } = useSortable({
    id,
    disabled: { draggable: !sortable || moving, droppable: !sortable },
    transition: { duration, easing: "var(--ease-move)" },
  });
  return (
    <div
      ref={setNodeRef}
      {...(!present && { inert: "" })}
      style={{
        transform: CSS.Translate.toString(waiting && transform ? { ...transform, x: 0 } : null),
        transition,
      }}
      className={cn("relative", isDragging && "z-10")}
    >
      <Collapse>
        <div
          className={cn(
            "border-border-subtle bg-bg-muted text-text-secondary mb-1 flex h-8 items-center gap-1 rounded-lg border px-0.5 text-sm pointer-coarse:h-12",
            (origin || reason) && "h-auto min-h-12 py-1 pointer-coarse:min-h-18",
            isDragging && "border-border-strong shadow-sm"
          )}
        >
          <div className="w-7 shrink-0 pointer-coarse:w-11">
            {waiting && (
              <Button
                ref={setActivatorNodeRef}
                {...attributes}
                {...listeners}
                size="icon-xs"
                variant="ghost"
                className="text-text-tertiary cursor-grab active:cursor-grabbing"
                aria-label={`Reorder queued message ${index + 1}`}
                title="Reorder queued message"
              >
                <GripVertical className="size-4" />
              </Button>
            )}
          </div>
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5",
              origin && "grid grid-cols-[minmax(0,1fr)_auto] gap-y-0"
            )}
          >
            {origin && (
              <div className="col-span-full flex min-w-0">
                <SentFrom origin={origin} />
              </div>
            )}
            {text && (
              <span className="truncate" title={text}>
                {text}
              </span>
            )}
            {reason && <span className="text-warning col-span-full text-xs">{reason}</span>}
            {images > 0 && <ImageCount count={images} besideText={Boolean(text)} />}
          </div>
          <div
            className={cn(
              "flex shrink-0 items-center justify-end",
              waiting && "w-21 pointer-coarse:w-33"
            )}
          >
            {waiting ? (
              <>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Edit queued message"
                  title="Edit queued message"
                  disabled={editDisabled}
                  onClick={() => onEdit(id).catch(showError)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Remove queued message"
                  title="Remove queued message"
                  onClick={() => call(api.removeQueuedMessage, { sessionId, id }).catch(showError)}
                >
                  <X className="size-3.5" />
                </Button>
                <div className="grid w-7 place-items-center pointer-coarse:w-11">
                  {canSteer && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="rounded-full"
                          aria-label="Send to current turn"
                          onClick={(e) => {
                            if (e.detail > 1) return;
                            call(api.steerQueuedMessage, { sessionId, id, turnId }).catch(
                              showError
                            );
                          }}
                        >
                          <span className="bg-button-primary text-button-primary-foreground grid size-6 place-items-center rounded-full">
                            <ArrowUp className="size-4" />
                          </span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Send to current turn</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </>
            ) : (
              <span className="text-text-tertiary dark:text-text-secondary pr-1.5 text-xs whitespace-nowrap">
                {state === "sending" ? "Sending" : "Waiting to be read"}
              </span>
            )}
          </div>
        </div>
      </Collapse>
    </div>
  );
}

// Apply just this drop to the live rows while the host answers. A delivery can remove either row.
function previewMove(items: Row[], move: Move | null) {
  if (!move) return items;
  const from = items.findIndex((row) => row.state === "waiting" && row.id === move.id);
  const before =
    move.before === null
      ? items.length
      : items.findIndex((row) => row.state === "waiting" && row.id === move.before);
  if (from < 0 || before < 0) return items;
  return arrayMove(items, from, before > from ? before - 1 : before);
}

export function QueuedMessageList(controls: QueueControls) {
  const { sessionId } = controls;
  const { data } = useQueuedMessages(sessionId);
  const [pending, setPending] = useState<Move | null>(null);
  const rows = previewMove(data?.items ?? [], pending);
  const waiting = rows.filter((row) => row.state === "waiting").map((row) => row.id);
  const sensors = useReorderSensors();
  const resetsAt = data?.limit?.resetsAt;
  const until = resetsAt !== undefined && !hasLimitReset(resetsAt) ? limitTime(resetsAt) : null;
  const pause = {
    stopped: "Queue paused. The agent was stopped.",
    failed: "Queue paused after an error.",
    limit: until ? `Queue paused until ${until}.` : "Queue paused. A usage limit was reached.",
  };

  function drop({ active, over }: DragEndEvent) {
    if (!over || over.id === active.id || pending) return;
    const id = String(active.id);
    const from = waiting.indexOf(id);
    const to = waiting.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const before = arrayMove(waiting, from, to)[to + 1] ?? null;
    const move = { id, before };
    setPending(move);
    void call(api.moveQueuedMessage, { sessionId, ...move })
      .catch(showError)
      .finally(() => setPending(null));
  }

  const position = (id: string | number) => waiting.indexOf(String(id)) + 1;
  return (
    <div
      role="group"
      aria-label="Queued messages"
      {...(rows.length === 0 && { inert: "" })}
      className="max-h-[min(12rem,25dvh)] overflow-y-auto pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={drop}
        accessibility={{
          announcements: {
            onDragStart: ({ active }) =>
              `Picked up queued message ${position(active.id)} of ${waiting.length}.`,
            onDragOver: ({ over }) =>
              over ? `Position ${position(over.id)} of ${waiting.length}.` : undefined,
            onDragEnd: ({ over }) =>
              over ? `Dropped at position ${position(over.id)}.` : "Move cancelled.",
            onDragCancel: () => "Move cancelled.",
          },
        }}
      >
        <SortableContext items={waiting} strategy={verticalListSortingStrategy}>
          <AnimatePresence initial={false}>
            {rows.length > 0 && data?.paused && (
              <Collapse key="paused" className="bg-background sticky top-0 z-10">
                <div className="text-text-secondary flex min-h-8 items-center justify-between gap-2 px-2 text-xs">
                  <span role="status">{pause[data.paused]}</span>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => call(api.resumeQueuedMessages, { sessionId }).catch(showError)}
                  >
                    Resume
                  </Button>
                </div>
              </Collapse>
            )}
            {rows.map((row) => (
              <QueuedRow key={row.id} row={row} moving={!!pending} {...controls} />
            ))}
          </AnimatePresence>
        </SortableContext>
      </DndContext>
    </div>
  );
}
