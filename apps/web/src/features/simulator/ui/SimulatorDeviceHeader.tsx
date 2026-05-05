import { Camera, Crosshair, Home, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { SimPhase } from "../store";
import type { SimulatorInfo } from "../types";
import { formatSimulatorRuntime } from "./simulatorDisplay";

interface SimulatorDeviceHeaderProps {
  state: SimPhase;
  selectedSim: SimulatorInfo | undefined;
  isLive: boolean;
  inspectMode: boolean;
  inspectLoading: boolean;
  onHome: () => void;
  onScreenshot: () => void;
  onToggleInspect: () => void;
}

export function SimulatorDeviceHeader({
  state,
  selectedSim,
  isLive,
  inspectMode,
  inspectLoading,
  onHome,
  onScreenshot,
  onToggleInspect,
}: SimulatorDeviceHeaderProps) {
  const controlsDisabled = !isLive;
  const statusLabel = getStatusLabel(state);

  return (
    <div className="border-border-subtle bg-bg-surface/95 flex min-h-9 w-full items-center gap-2.5 rounded-xl border px-2.5 py-1.5 shadow-sm backdrop-blur">
      <span
        aria-label={statusLabel}
        className={cn("h-2 w-2 shrink-0 rounded-full", {
          "bg-muted-foreground/50": state.phase === "idle",
          "bg-warning animate-pulse": state.phase === "booting" || state.phase === "building",
          "bg-success shadow-[0_0_8px_color-mix(in_oklch,var(--success)_35%,transparent)]":
            state.phase === "streaming" || state.phase === "running",
          "bg-destructive": state.phase === "error",
        })}
      />
      <p className="min-w-0 flex-1 truncate text-xs">
        <span className="text-text-secondary font-semibold">
          {selectedSim?.name ?? "iOS Simulator"}
        </span>
        {selectedSim && (
          <span className="text-text-muted"> · {formatSimulatorRuntime(selectedSim.runtime)}</span>
        )}
      </p>

      <div
        className={cn(
          "border-border-subtle bg-bg-base flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5 transition-opacity duration-150 ease-[ease]",
          controlsDisabled && "opacity-45"
        )}
      >
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
            {controlsDisabled ? "Start simulator to use Home" : "Home"}
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
            {controlsDisabled ? "Start simulator to take screenshots" : "Screenshot ⌘⇧S"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                variant={inspectMode ? "outline" : "ghost"}
                size="sm"
                onClick={onToggleInspect}
                disabled={controlsDisabled || inspectLoading}
                aria-label={inspectMode ? "Disable inspect mode" : "Inspect app views"}
                className={cn("h-7 w-7 p-0", inspectMode && "border-primary/40 text-primary")}
              >
                {inspectLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Crosshair className="h-3 w-3" />
                )}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {controlsDisabled
              ? "Start simulator to inspect app views"
              : inspectMode
                ? "Inspecting views; Option-click to pin"
                : "Inspect app views"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function getStatusLabel(state: SimPhase) {
  switch (state.phase) {
    case "idle":
      return "Simulator idle";
    case "booting":
      return "Simulator booting";
    case "streaming":
      return "Simulator streaming";
    case "building":
      return "Building app";
    case "running":
      return "App running";
    case "error":
      return "Simulator error";
  }
}
