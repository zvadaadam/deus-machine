import { AnimatePresence } from "framer-motion";
import { Image, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@shared/api";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { call } from "@/platform/ws";
import { useQueuedMessages } from "../api/session.queries";

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

export function QueuedMessageList({
  sessionId,
  canSteer,
  editDisabled,
  onEdit,
}: {
  sessionId: string;
  canSteer: boolean;
  editDisabled: boolean;
  onEdit: (id: string) => Promise<void>;
}) {
  const { data } = useQueuedMessages(sessionId);

  return (
    <div
      role="group"
      aria-label="Queued messages"
      className="max-h-[min(12rem,25dvh)] overflow-y-auto pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11"
    >
      <AnimatePresence initial={false}>
        {data?.paused && (
          <Collapse key="paused" className="bg-background sticky top-0 z-10">
            <div className="text-text-secondary flex min-h-8 items-center justify-between gap-2 px-2 text-xs">
              <span role="status">
                {data.paused === "stopped"
                  ? "Queue paused. The agent was stopped."
                  : "Queue paused after an error."}
              </span>
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
        {data?.items.map(({ id, text, images, state }) => (
          <Collapse key={`message:${id}`}>
            <div className="border-border-subtle bg-bg-muted text-text-secondary mb-1 flex h-8 items-center gap-2 rounded-lg border pr-1 pl-2.5 text-sm pointer-coarse:h-12">
              {state !== "waiting" && (
                <span className="text-text-muted shrink-0 text-xs">
                  {state === "sending" ? "Sending" : "Waiting to be read"}
                </span>
              )}
              {text && (
                <span className="min-w-0 truncate" title={text}>
                  {text}
                </span>
              )}
              {images > 0 && <ImageCount count={images} besideText={Boolean(text)} />}
              {state === "waiting" && (
                <div className="ml-auto flex shrink-0 items-center">
                  {canSteer && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        call(api.steerQueuedMessage, { sessionId, id }).catch(showError)
                      }
                    >
                      Steer
                    </Button>
                  )}
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
                    onClick={() =>
                      call(api.removeQueuedMessage, { sessionId, id }).catch(showError)
                    }
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
          </Collapse>
        ))}
      </AnimatePresence>
    </div>
  );
}
