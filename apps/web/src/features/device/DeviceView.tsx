import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  DeviceScreen,
  displayScreen,
  useDeviceClient,
  useDeviceScreenClient,
} from "@expo/hub-client";
import { toast } from "sonner";
import { Camera, House } from "lucide-react";
import type { HubDevice } from "@shared/types/device-hub";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import {
  attachImageFiles,
  composerTarget,
  type ComposerTarget,
} from "@/features/session/store/sessionComposerStore";

export function DeviceActions({ session }: { session: string | null }) {
  const client = useDeviceClient();
  const capture = useMutation({
    mutationFn: async (target: ComposerTarget) => {
      const shot = await client.screenshot({ format: "png" });
      if (!shot) throw new Error("The device could not capture a screenshot.");
      const attached = await attachImageFiles(target, [
        new File([shot.blob], "device-screenshot.png", { type: shot.blob.type }),
      ]);
      if (!attached) throw new Error("The screenshot could not be added to the chat.");
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });
  return (
    <div className="ml-auto flex shrink-0 items-center">
      <Button
        aria-label="Home"
        title="Home"
        size="xs"
        variant="ghost"
        disabled={!client.framePresented}
        onClick={() => client.pressButton("home")}
      >
        <House />
        <span className="hidden @sm:inline">Home</span>
      </Button>
      <Button
        aria-label="Screenshot"
        title="Screenshot"
        size="xs"
        variant="ghost"
        disabled={!client.framePresented || !session || capture.isPending}
        onClick={() => session && capture.mutate(composerTarget(session))}
      >
        <Camera />
        <span className="hidden @sm:inline">Screenshot</span>
      </Button>
    </div>
  );
}

export function DeviceView({
  device,
  onDisplay,
}: {
  device: HubDevice;
  onDisplay: (device: HubDevice) => void;
}) {
  const screen = useDeviceScreenClient();
  useEffect(() => {
    if (screen.framePresented) onDisplay(device);
  }, [device, onDisplay, screen.framePresented]);
  const size = displayScreen(screen.screen);
  const ratio = size ? size.width / size.height : 9 / 19.5;
  return (
    <div className="[container-type:size] relative m-3 grid min-h-0 flex-1 place-items-center">
      <div
        className="relative overflow-hidden rounded-lg"
        style={{ width: `min(100cqw, ${100 * ratio}cqh)`, aspectRatio: ratio }}
      >
        <DeviceScreen client={screen} />
      </div>
      {(!screen.framePresented || screen.inputError || screen.status === "error") && (
        <p
          role="status"
          className="bg-background text-muted-foreground pointer-events-none absolute max-w-full rounded-lg px-3 py-2 text-center text-sm"
        >
          {screen.inputError || screen.error || "Connecting to the device…"}
        </p>
      )}
    </div>
  );
}
