import { match } from "ts-pattern";
import { AlertCircle, Check, ChevronDown, Loader2, Rocket, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import type { SimPhase } from "../store";
import type { SimulatorInfo } from "../types";
import { AppleLogoIcon } from "./AppleLogoIcon";
import { formatSimulatorRuntime } from "./simulatorDisplay";

interface SimulatorContentHeaderProps {
  state: SimPhase;
  simulators: SimulatorInfo[];
  selectedSim: SimulatorInfo | undefined;
  selectedUdid: string | null;
  selectorDisabled: boolean;
  claimedUdids: Set<string>;
  isLive: boolean;
  hidAvailable: boolean;
  hasProject: boolean | null;
  onSelectSimulator: (udid: string) => void;
  onBuildAndRun: () => void;
  onRetry: () => void;
  onStop: () => void;
}

export function SimulatorContentHeader({
  state,
  simulators,
  selectedSim,
  selectedUdid,
  selectorDisabled,
  claimedUdids,
  isLive,
  hidAvailable,
  hasProject,
  onSelectSimulator,
  onBuildAndRun,
  onRetry,
  onStop,
}: SimulatorContentHeaderProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 px-3">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={selectorDisabled}
            aria-label="Select simulator device"
            aria-haspopup="listbox"
            className="border-border-subtle/70 bg-bg-overlay/70 text-text-secondary hover:bg-bg-overlay hover:text-foreground focus-visible:ring-ring/40 flex h-7 max-w-[360px] items-center gap-1.5 rounded-lg border px-2 text-xs transition-[background-color,border-color,color,box-shadow] duration-150 ease-out focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
          >
            <AppleLogoIcon className="h-[13px] w-[13px] shrink-0" />
            <span className="truncate">
              {selectedSim
                ? `${selectedSim.name}  ${formatSimulatorRuntime(selectedSim.runtime)}`
                : "Select simulator..."}
            </span>
            <ChevronDown className="h-[10px] w-[10px] shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="min-w-[220px] shadow-sm">
          {simulators.map((sim) => {
            const isClaimed = claimedUdids.has(sim.udid);
            return (
              <DropdownMenuItem
                key={sim.udid}
                disabled={isClaimed}
                onClick={() => onSelectSimulator(sim.udid)}
                className="cursor-pointer gap-2 py-1.5 text-xs"
              >
                <Check
                  className={cn(
                    "h-3 w-3 shrink-0",
                    selectedUdid === sim.udid ? "opacity-100" : "opacity-0"
                  )}
                />
                {sim.state === "Booted" && (
                  <span className="bg-success h-1.5 w-1.5 shrink-0 rounded-full" />
                )}
                <span className="truncate">{sim.name}</span>
                <span className="text-text-muted ml-auto text-xs">
                  {isClaimed ? "In use" : formatSimulatorRuntime(sim.runtime)}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      {isLive && !hidAvailable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-warning flex cursor-help items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              <span className="text-xs">No touch</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px]">
            <p className="text-xs">
              HID client not available. Touch, scroll, and keyboard input won't work. Check
              Xcode/Simulator.app installation.
            </p>
          </TooltipContent>
        </Tooltip>
      )}

      {match(state)
        .with({ phase: "idle" }, () => null)
        .with({ phase: "booting" }, () => (
          <Button variant="outline" size="sm" disabled className="h-7 gap-1.5 px-2.5 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            Booting
          </Button>
        ))
        .with({ phase: "streaming" }, () =>
          hasProject ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onBuildAndRun}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <Rocket className="h-3 w-3" />
              Build & Run
            </Button>
          ) : hasProject === false ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-not-allowed">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    className="h-7 gap-1.5 px-2.5 text-xs opacity-40"
                  >
                    <Rocket className="h-3 w-3" />
                    Build & Run
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                No Xcode project found in this workspace
              </TooltipContent>
            </Tooltip>
          ) : null
        )
        .with({ phase: "building" }, () => (
          <Button variant="outline" size="sm" disabled className="h-7 gap-1.5 px-2.5 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            Building
          </Button>
        ))
        .with({ phase: "running" }, () =>
          hasProject ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onBuildAndRun}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <RotateCcw className="h-3 w-3" />
              Rebuild
            </Button>
          ) : null
        )
        .with({ phase: "error" }, (errorState) =>
          errorState.canRetry ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </Button>
          ) : null
        )
        .exhaustive()}

      {state.phase !== "idle" && state.phase !== "error" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onStop} className="h-7 w-7 p-0">
              <Square className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Stop simulator</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
