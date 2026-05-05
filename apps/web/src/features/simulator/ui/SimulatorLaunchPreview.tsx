import { AlertCircle, Loader2, Play, RotateCcw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SimulatorInfo } from "../types";
import { DeviceFrame } from "./DeviceFrame";
import { SimulatorEmptySurface } from "./SimulatorEmptySurface";

type LaunchPreviewPhase = "idle" | "booting" | "error";

interface SimulatorLaunchPreviewProps {
  phase: LaunchPreviewPhase;
  selectedSim: SimulatorInfo | undefined;
  selectedUdid: string | null;
  errorMessage?: string;
  canRetry?: boolean;
  onStart?: () => void;
  onRetry?: () => void;
  deviceHeader?: React.ReactNode;
}

export function SimulatorLaunchPreview({
  phase,
  selectedSim,
  selectedUdid,
  errorMessage,
  canRetry = false,
  onStart,
  onRetry,
  deviceHeader,
}: SimulatorLaunchPreviewProps) {
  if (!selectedSim) {
    return (
      <div className="absolute inset-0">
        <SimulatorEmptySurface
          icon={<Smartphone className="h-5 w-5" />}
          title={selectedUdid ? "Simulator unavailable" : "No simulator selected"}
          description={
            selectedUdid
              ? "The selected simulator is no longer available. Pick another simulator from the header."
              : "Choose an iOS simulator from the header to start the stream."
          }
        />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-hidden">
      <DeviceFrame deviceType={selectedSim?.device_type} header={deviceHeader}>
        <div className="bg-bg-base flex h-full w-full items-center justify-center p-6 text-center">
          {phase === "idle" && (
            <Button
              onClick={onStart}
              disabled={!selectedUdid}
              className="min-h-11 min-w-[180px] gap-2 rounded-xl transition-[background-color,border-color,color,box-shadow] duration-150"
            >
              <Play className="h-4 w-4" />
              Start Simulator
            </Button>
          )}

          {phase === "booting" && (
            <div className="flex flex-col items-center gap-3" aria-live="polite">
              <Loader2 className="text-primary h-6 w-6 animate-spin" />
              <p className="text-text-secondary text-sm font-medium">Starting simulator</p>
            </div>
          )}

          {phase === "error" && (
            <div className="flex max-w-[240px] flex-col items-center gap-3" aria-live="polite">
              <AlertCircle className="text-destructive h-5 w-5" />
              <p className="text-destructive text-sm leading-5">
                {errorMessage ?? "Something went wrong starting the simulator."}
              </p>
              {canRetry && (
                <Button
                  variant="outline"
                  onClick={onRetry}
                  className="min-h-10 min-w-[136px] gap-2 rounded-xl"
                >
                  <RotateCcw className="h-4 w-4" />
                  Try Again
                </Button>
              )}
            </div>
          )}
        </div>
      </DeviceFrame>
    </div>
  );
}
