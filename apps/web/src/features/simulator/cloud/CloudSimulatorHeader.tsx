/**
 * The floating control strip above the cloud device frame — the cloud twin
 * of SimulatorDeviceHeader: status dot + label, Start/Stop, Home, Screenshot.
 */

import { Camera, Check, ExternalLink, Home, Link2, Loader2, Play, Square } from "lucide-react";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { CloudSimDevice } from "./cloudSimulatorStore";
import { cloudDeviceLabel, type CloudSimPhase } from "./cloudSimulatorPhase";

function phaseLabel(phase: CloudSimPhase): string {
  return match(phase)
    .with("idle", () => "Off")
    .with("booting", () => "Starting")
    .with("live", () => "Live")
    .with("stopping", () => "Stopping")
    .with("error", () => "Error")
    .exhaustive();
}

interface CloudSimulatorHeaderProps {
  device: CloudSimDevice;
  phase: CloudSimPhase;
  onStart: () => void;
  onStop: () => void;
  onHome: () => void;
  onScreenshot: () => void;
  /** Pop the platform's full device viewer (pointer, rotate, logs) out into
   *  its own window at native size. */
  onOpenExternal: () => void;
  /** Put the live stream URL on the clipboard — the same link the agent
   *  pastes into chat; anyone with it can watch and drive the device. */
  onCopyLink: () => void;
  /** True for a moment after a copy, for the "Copied" acknowledgement. */
  copied: boolean;
}

export function CloudSimulatorHeader({
  device,
  phase,
  onStart,
  onStop,
  onHome,
  onScreenshot,
  onOpenExternal,
  onCopyLink,
  copied,
}: CloudSimulatorHeaderProps) {
  const label = cloudDeviceLabel(device.platform);
  const status = phaseLabel(phase);
  // Stop covers the whole boot→live span (a boot the user regrets must be
  // cancellable); Start is the affordance everywhere else.
  const showStop = phase === "booting" || phase === "live";
  const inFlight = device.busy !== null || phase === "stopping";
  // Device operations need a device that answers — only a live one does.
  const controlsDisabled = phase !== "live" || inFlight;

  return (
    <div className="border-border-subtle bg-bg-surface/95 flex min-h-9 w-full items-center gap-2.5 rounded-xl border px-2.5 py-1.5 shadow-sm backdrop-blur">
      <span
        aria-label={`${label}: ${status}`}
        className={cn("h-2 w-2 shrink-0 rounded-full", {
          "bg-muted-foreground/50": phase === "idle",
          "bg-warning animate-pulse": phase === "booting" || phase === "stopping",
          "bg-success shadow-[0_0_8px_color-mix(in_oklch,var(--success)_35%,transparent)]":
            phase === "live",
          "bg-destructive": phase === "error",
        })}
      />
      <p className="min-w-0 flex-1 truncate text-xs">
        <span className="text-text-secondary font-semibold">{label}</span>
        <span className="text-text-muted"> · {status}</span>
      </p>

      <div className="border-border-subtle bg-bg-base flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                onClick={showStop ? onStop : onStart}
                disabled={inFlight}
                aria-label={showStop ? "Stop device" : "Start device"}
                className="h-7 w-7 p-0"
              >
                {inFlight ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : showStop ? (
                  <Square className="h-3 w-3" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {inFlight ? status : showStop ? "Stop device" : "Start device"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                onClick={onHome}
                disabled={controlsDisabled}
                aria-label="Home"
                className="h-7 w-7 p-0"
              >
                <Home className="h-3 w-3" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {controlsDisabled ? "Start the device to use Home" : "Home"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                onClick={onScreenshot}
                disabled={controlsDisabled}
                aria-label="Screenshot"
                className="h-7 w-7 p-0"
              >
                <Camera className="h-3 w-3" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {controlsDisabled ? "Start the device to take screenshots" : "Screenshot to chat"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenExternal}
                disabled={phase !== "live"}
                aria-label="Open in window"
                className="h-7 w-7 p-0"
              >
                <ExternalLink className="h-3 w-3" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {phase !== "live" ? "Start the device to open it in a window" : "Open in window"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                onClick={onCopyLink}
                disabled={phase !== "live"}
                aria-label={copied ? "Copied" : "Copy stream link"}
                className="h-7 w-7 p-0"
              >
                {copied ? (
                  <Check className="text-success h-3 w-3" />
                ) : (
                  <Link2 className="h-3 w-3" />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {copied
              ? "Copied"
              : phase !== "live"
                ? "Start the device to share its stream"
                : "Copy stream link"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
