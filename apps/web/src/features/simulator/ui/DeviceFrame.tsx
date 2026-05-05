import { useMemo, type CSSProperties } from "react";

interface DeviceFrameProps {
  deviceType: string | null | undefined;
  screenSize?: ScreenSize | null;
  header?: React.ReactNode;
  children: React.ReactNode;
}

type SimulatorDeviceKind = "iphone" | "ipad";

interface ScreenSize {
  width: number;
  height: number;
}

interface DeviceGeometry {
  aspectRatio: string;
  screenRadius: string;
  height: string;
  maxWidth: string;
}

const SCREEN_GEOMETRY = {
  iphone: { frameWidth: 427, frameHeight: 881, insetX: 18, insetY: 18, cornerRadius: 55 },
  ipad: { frameWidth: 430, frameHeight: 605, insetX: 16, insetY: 16, cornerRadius: 12 },
} as const;

const KNOWN_SCREEN_SIZES: Record<string, ScreenSize> = {
  iphone17promax: { width: 1320, height: 2868 },
  iphone17pro: { width: 1206, height: 2622 },
  iphone17: { width: 1206, height: 2622 },
  iphoneair: { width: 1260, height: 2736 },
  iphone16promax: { width: 1320, height: 2868 },
  iphone16pro: { width: 1206, height: 2622 },
  iphone16plus: { width: 1290, height: 2796 },
  iphone16: { width: 1179, height: 2556 },
  iphone16e: { width: 1170, height: 2532 },
  iphone15promax: { width: 1290, height: 2796 },
  iphone15pro: { width: 1179, height: 2556 },
  iphone15plus: { width: 1290, height: 2796 },
  iphone15: { width: 1179, height: 2556 },
  ipadpro13inchm5: { width: 2064, height: 2752 },
  ipadpro11inchm5: { width: 1668, height: 2420 },
  ipadpro13inchm4: { width: 2064, height: 2752 },
  ipadpro11inchm4: { width: 1668, height: 2420 },
  ipadair13inchm3: { width: 2048, height: 2732 },
  ipadair11inchm3: { width: 1640, height: 2360 },
  ipada16: { width: 1640, height: 2360 },
  ipadminia17pro: { width: 1488, height: 2266 },
};

function normalizeDeviceName(deviceType: string | null | undefined): string {
  return (deviceType ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getDeviceKind(deviceType: string | null | undefined): SimulatorDeviceKind {
  return deviceType?.toLowerCase().includes("ipad") ? "ipad" : "iphone";
}

function fallbackScreenSize(
  kind: SimulatorDeviceKind,
  deviceType: string | null | undefined
): ScreenSize {
  const known = KNOWN_SCREEN_SIZES[normalizeDeviceName(deviceType)];
  if (known) return known;

  const frame = SCREEN_GEOMETRY[kind];
  return {
    width: frame.frameWidth - 2 * frame.insetX,
    height: frame.frameHeight - 2 * frame.insetY,
  };
}

function getScreenRadius(kind: SimulatorDeviceKind, screenSize: ScreenSize): string {
  const frame = SCREEN_GEOMETRY[kind];
  const screenWidth = frame.frameWidth - 2 * frame.insetX;
  const screenHeight = frame.frameHeight - 2 * frame.insetY;
  const isLandscape = screenSize.width > screenSize.height;

  if (isLandscape && screenWidth < screenHeight) {
    return `${(frame.cornerRadius / screenHeight) * 100}% / ${
      (frame.cornerRadius / screenWidth) * 100
    }%`;
  }

  return `${(frame.cornerRadius / screenWidth) * 100}% / ${
    (frame.cornerRadius / screenHeight) * 100
  }%`;
}

function getDeviceGeometry(
  deviceType: string | null | undefined,
  streamScreenSize: ScreenSize | null | undefined
): DeviceGeometry {
  const kind = getDeviceKind(deviceType);
  const screenSize = streamScreenSize ?? fallbackScreenSize(kind, deviceType);
  const isLandscape = screenSize.width > screenSize.height;

  if (kind === "ipad") {
    return {
      aspectRatio: `${screenSize.width} / ${screenSize.height}`,
      screenRadius: getScreenRadius(kind, screenSize),
      height: "78%",
      maxWidth: isLandscape ? "92%" : "86%",
    };
  }

  return {
    aspectRatio: `${screenSize.width} / ${screenSize.height}`,
    screenRadius: getScreenRadius(kind, screenSize),
    height: "78%",
    maxWidth: isLandscape ? "92%" : "82%",
  };
}

export function DeviceFrame({ deviceType, screenSize, header, children }: DeviceFrameProps) {
  const geometry = useMemo(
    () => getDeviceGeometry(deviceType, screenSize),
    [deviceType, screenSize]
  );
  const frameHeight = header ? `calc(${geometry.height} - 22px)` : geometry.height;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden p-6">
      <div
        className="relative shrink"
        style={{
          height: frameHeight,
          maxWidth: geometry.maxWidth,
          maxHeight: frameHeight,
          aspectRatio: geometry.aspectRatio,
        }}
      >
        {header && (
          <div className="absolute right-0 bottom-[calc(100%+10px)] left-0 z-30">{header}</div>
        )}

        <div
          className="bg-bg-base relative h-full w-full overflow-hidden shadow-[0_24px_80px_color-mix(in_oklch,var(--foreground)_12%,transparent),0_0_0_1px_color-mix(in_oklch,var(--foreground)_8%,transparent)]"
          style={
            {
              borderRadius: geometry.screenRadius,
              cornerShape: "superellipse(1.3)",
            } as CSSProperties
          }
        >
          <div className="relative h-full w-full">{children}</div>
        </div>
      </div>
    </div>
  );
}
