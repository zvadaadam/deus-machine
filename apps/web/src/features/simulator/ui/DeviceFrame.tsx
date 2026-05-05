/**
 * DeviceFrame — renders a device bezel around the simulator canvas.
 *
 * When generated Apple-derived frame assets are available, we use them.
 * Otherwise we fall back to a neutral in-app shell so the simulator still
 * looks intentional instead of degrading to a raw white rectangle.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ensureManifestLoaded,
  hasDeviceChromeManifest,
  resolveDeviceChrome,
} from "../device-chrome";

interface DeviceFrameProps {
  deviceType: string | null | undefined;
  children: React.ReactNode;
}

interface GenericShellSpec {
  aspectRatio: string;
  shellRadius: string;
  screenRadius: string;
  screenInsets: {
    top: string;
    left: string;
    right: string;
    bottom: string;
  };
}

function getGenericShellSpec(deviceType: string | null | undefined): GenericShellSpec {
  const isTablet = deviceType?.includes("iPad") ?? false;

  if (isTablet) {
    return {
      aspectRatio: "834 / 1194",
      shellRadius: "2.75rem",
      screenRadius: "2.1rem",
      screenInsets: { top: "2.1%", left: "2.2%", right: "2.2%", bottom: "2.1%" },
    };
  }

  return {
    aspectRatio: "430 / 932",
    shellRadius: "3.25rem",
    screenRadius: "2.6rem",
    screenInsets: { top: "1.7%", left: "2.5%", right: "2.5%", bottom: "1.9%" },
  };
}

function FrameContainer({
  aspectRatio,
  children,
}: {
  aspectRatio: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden p-6">
      <div
        style={{
          position: "relative",
          height: "80%",
          maxWidth: "80%",
          maxHeight: "80%",
          aspectRatio,
          flexShrink: 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function GenericDeviceFrame({ deviceType, children }: DeviceFrameProps) {
  const shell = useMemo(() => getGenericShellSpec(deviceType), [deviceType]);
  const isTablet = deviceType?.includes("iPad") ?? false;

  return (
    <FrameContainer aspectRatio={shell.aspectRatio}>
      <div
        className="bg-bg-surface border-border-subtle absolute inset-0 overflow-hidden border shadow-2xl"
        style={{ borderRadius: shell.shellRadius }}
      >
        <div
          className="border-border/40 pointer-events-none absolute inset-[0.6%] rounded-[inherit] border"
          aria-hidden="true"
        />

        {isTablet && (
          <div
            className="bg-bg-base ring-border/40 pointer-events-none absolute top-[1.45%] left-1/2 z-20 h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-2"
            aria-hidden="true"
          />
        )}

        <div
          className="bg-bg-base absolute z-10 overflow-hidden"
          style={{
            top: shell.screenInsets.top,
            left: shell.screenInsets.left,
            right: shell.screenInsets.right,
            bottom: shell.screenInsets.bottom,
            borderRadius: shell.screenRadius,
          }}
        >
          <div className="relative h-full w-full">{children}</div>
        </div>
      </div>
    </FrameContainer>
  );
}

export function DeviceFrame({ deviceType, children }: DeviceFrameProps) {
  const [manifestReady, setManifestReady] = useState(false);

  useEffect(() => {
    if (manifestReady) return;
    ensureManifestLoaded().then(() => setManifestReady(true));
  }, [manifestReady]);

  const spec = useMemo(() => resolveDeviceChrome(deviceType), [deviceType, manifestReady]);

  if (!manifestReady || !hasDeviceChromeManifest() || !spec) {
    return <GenericDeviceFrame deviceType={deviceType}>{children}</GenericDeviceFrame>;
  }

  return (
    <FrameContainer aspectRatio={spec.aspectRatio}>
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
    </FrameContainer>
  );
}
