import { useRef, useState } from "react";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Loader2, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fixSetupErrorPrompt } from "@/features/session/lib/sessionPrompts";
import { tempo } from "@/shared/lib/tempo";
import { cn } from "@/shared/lib/utils";
import type { SetupStatus } from "@/shared/types";
import { useSetupActions } from "../hooks/useSetupActions";
import { SETUP_FAILED, SETUP_RUNNING, setupWarning, type StartWarning } from "../lib/startState";
import { SetupLogDialog } from "./SetupLogDialog";

export interface SetupWarningActionSet {
  workspaceId: string;
  retry: () => void;
  retrying: boolean;
  /** Sends a fix prompt to the active chat when one is available. */
  onSendAgentMessage?: (text: string) => void;
  /** Controlled log handler (used inside a Popover so opening the dialog can close it first). */
  onViewLog?: () => void;
  /** Called right before retry/fix (e.g. close popover or move focus off unmounting buttons). */
  onBeforeAction?: () => void;
}

// Keep the xs button's visible surface while filling a comfortable touch target.
const TOUCH_ACTION =
  "relative before:absolute before:inset-x-0 before:top-1/2 before:h-7.5 before:-translate-y-1/2 pointer-coarse:before:h-11";

function formatFixError(warning: StartWarning): string {
  return [warning.message, warning.output].filter(Boolean).join("\n\n");
}

/**
 * Shared details + action row for a non-blocking start or setup warning.
 * Used identically inside the transcript start card and the header's progressive popover.
 */
export function SetupWarningDetails({
  warning,
  actions,
  className,
}: {
  warning: StartWarning;
  actions?: SetupWarningActionSet;
  className?: string;
}) {
  const logButton = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className={cn(TOUCH_ACTION, "text-text-tertiary hover:text-text-primary")}
      onClick={actions?.onViewLog}
    >
      View log
    </Button>
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p className="text-text-secondary text-xs leading-relaxed text-pretty wrap-anywhere select-text">
        {warning.message}
      </p>
      {warning.output && (
        <pre className="bg-bg-raised border-border-subtle text-text-secondary max-h-32 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap select-text">
          <samp className="font-mono">{warning.output}</samp>
        </pre>
      )}
      {actions && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 pt-0.5 pointer-coarse:gap-y-3">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className={TOUCH_ACTION}
            disabled={actions.retrying}
            onClick={() => {
              actions.onBeforeAction?.();
              actions.retry();
            }}
          >
            <RotateCcw aria-hidden className="size-3" /> Run again
          </Button>
          {actions.onSendAgentMessage && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className={TOUCH_ACTION}
              onClick={() => {
                actions.onBeforeAction?.();
                actions.onSendAgentMessage?.(fixSetupErrorPrompt(formatFixError(warning)));
              }}
            >
              <Sparkles aria-hidden className="size-3" /> Ask AI to fix
            </Button>
          )}
          {actions.onViewLog ? (
            logButton
          ) : (
            <SetupLogDialog workspaceId={actions.workspaceId}>{logButton}</SetupLogDialog>
          )}
        </div>
      )}
    </div>
  );
}

interface WorkspaceSetupStatusProps {
  workspaceId: string;
  setupStatus?: SetupStatus;
  setupError?: string | null;
  setupErrorDetail?: string | null;
  onSendAgentMessage?: (text: string) => void;
}

/**
 * Compact header indicator for workspace setup.
 *
 * Keyed by workspaceId so switching workspaces never carries an open popover or
 * log dialog across to another workspace.
 */
export function WorkspaceSetupStatus(props: WorkspaceSetupStatusProps) {
  return <WorkspaceSetupStatusInner key={props.workspaceId} {...props} />;
}

function WorkspaceSetupStatusInner({
  workspaceId,
  setupStatus,
  setupError,
  setupErrorDetail,
  onSendAgentMessage,
}: WorkspaceSetupStatusProps) {
  const { retry, retrying } = useSetupActions(workspaceId);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();

  const iconMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.85 },
        animate: { opacity: 1, scale: 1, transition: tempo.spring.fast },
        exit: { opacity: 0, scale: 0.85, transition: tempo.fast.exit },
      };

  const warning =
    setupStatus === "failed"
      ? setupWarning({
          state: "ready",
          error_message: setupError,
          error_detail: setupErrorDetail,
        })
      : null;

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        {setupStatus === "running" && (
          <m.span key="setup-running" {...iconMotion} className="flex shrink-0 items-center">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  aria-label={SETUP_RUNNING}
                  className="text-text-muted focus-visible:ring-ring flex h-6 w-6 items-center justify-center rounded-lg focus-visible:ring-2 focus-visible:outline-none"
                >
                  <Loader2
                    aria-hidden
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">{SETUP_RUNNING}</p>
              </TooltipContent>
            </Tooltip>
          </m.span>
        )}

        {setupStatus === "failed" && warning && (
          <m.span key="setup-failed" {...iconMotion} className="flex shrink-0 items-center">
            <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
              <Tooltip delayDuration={200} open={popoverOpen ? false : undefined}>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      ref={triggerRef}
                      type="button"
                      aria-label={SETUP_FAILED}
                      className={cn(
                        "control-interaction text-warning hover:bg-warning/10 active:bg-warning/15 relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg",
                        "pointer-coarse:before:absolute pointer-coarse:before:-inset-2",
                        popoverOpen && "bg-warning/10"
                      )}
                    >
                      <TriangleAlert aria-hidden className="size-3.5" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">{SETUP_FAILED} — click for details</p>
                </TooltipContent>
              </Tooltip>

              <PopoverContent
                align="start"
                sideOffset={6}
                className="border-border-subtle w-80 p-3.5 shadow-lg"
              >
                <div className="mb-2 flex items-center gap-2">
                  <TriangleAlert aria-hidden className="text-warning size-3.5 shrink-0" />
                  <span className="text-text-primary text-sm font-medium">{SETUP_FAILED}</span>
                  {warning.preview && (
                    <samp className="bg-warning/10 text-warning ml-auto max-w-[140px] truncate rounded-full px-2 py-0.5 font-mono text-[11px] font-medium">
                      {warning.preview}
                    </samp>
                  )}
                </div>
                <SetupWarningDetails
                  warning={warning}
                  actions={{
                    workspaceId,
                    retrying,
                    retry,
                    onSendAgentMessage,
                    onBeforeAction: () => setPopoverOpen(false),
                    onViewLog: () => {
                      setPopoverOpen(false);
                      setLogOpen(true);
                    },
                  }}
                />
              </PopoverContent>
            </Popover>
          </m.span>
        )}
      </AnimatePresence>

      {/* Sibling of Popover so closing the popover when opening the log never unmounts the dialog. */}
      <SetupLogDialog
        workspaceId={workspaceId}
        open={logOpen}
        onOpenChange={setLogOpen}
        onCloseAutoFocus={(event) => {
          if (triggerRef.current) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
      />
    </>
  );
}
