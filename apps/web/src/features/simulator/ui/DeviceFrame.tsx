/**
 * DeviceFrame — renders a device bezel around the simulator canvas.
 *
 * Sizing: the device container uses `container-type: size` on the
 * outer wrapper so the inner device can use cqi/cqb units to fit
 * within whichever dimension constrains it. Simple fallback: the
 * inner device just uses height:100% + aspect-ratio + max-width:100%
 * which CSS handles natively.
 */

import { useEffect, useMemo, useState } from "react";
import { resolveDeviceChrome, ensureManifestLoaded } from "../device-chrome";

interface DeviceFrameProps {
  deviceType: string | null | undefined;
  children: React.ReactNode;
}

export function DeviceFrame({ deviceType, children }: DeviceFrameProps) {
  const [manifestReady, setManifestReady] = useState(false);

  useEffect(() => {
    if (manifestReady) return;
    ensureManifestLoaded().then(() => setManifestReady(true));
  }, [manifestReady]);

  const spec = useMemo(() => resolveDeviceChrome(deviceType), [deviceType, manifestReady]);

  if (!spec) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden p-6">
      {/* Cap the device at 80% of each axis so there's breathing room
          around the frame. max-h/max-w both capped to 80%; aspect-ratio
          ensures the constrained axis drives overall size. */}
      <div
        style={{
          position: "relative",
          height: "80%",
          maxWidth: "80%",
          maxHeight: "80%",
          aspectRatio: spec.aspectRatio,
          flexShrink: 1,
        }}
      >
        {/* Bezel image */}
        <img
          src={spec.asset}
          className="pointer-events-none absolute inset-0 h-full w-full select-none"
          draggable={false}
          alt=""
        />

        {/* Screen area */}
        <div
          className="absolute z-10 overflow-hidden"
          style={{
            top: `${spec.screen.top}%`,
            left: `${spec.screen.left}%`,
            right: `${spec.screen.right}%`,
            bottom: `${spec.screen.bottom}%`,
            ...(spec.mask
              ? {
                  maskImage: `url(${spec.mask})`,
                  maskSize: "100% 100%",
                  maskRepeat: "no-repeat",
                  WebkitMaskImage: `url(${spec.mask})`,
                  WebkitMaskSize: "100% 100%",
                  WebkitMaskRepeat: "no-repeat",
                }
              : { borderRadius: "4%" }),
          }}
        >
          <div className="relative h-full w-full">{children}</div>
        </div>
      </div>
    </div>
  );
}
