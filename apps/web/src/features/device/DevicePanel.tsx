import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, House, Play } from "lucide-react";
import {
  DeviceClientProvider,
  DeviceScreen,
  displayScreen,
  useDeviceClient,
  useDeviceScreenClient,
} from "@expo/hub-client";
import * as api from "@shared/api/device-hub";
import { HUB_STREAM_MODE, type HubDevice, type HubStatus } from "@shared/types/device-hub";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import { call, OpError } from "@/platform/ws";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { resolveBackendEndpoints } from "@/shared/config/backend.config";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DeviceSetupLink } from "./DeviceSetupLink";
import { useStream } from "@/shared/hooks/useStream";
import { attachImageFiles, composerTarget } from "@/features/session/store/sessionComposerStore";
import { useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";

function DeviceDetails({ detail }: { detail?: string | null }) {
  if (!detail) return null;
  return (
    <details className="text-muted-foreground mt-1 text-left text-xs">
      <summary className="cursor-pointer">Technical details</summary>
      <pre className="mt-1 max-h-28 overflow-auto break-words whitespace-pre-wrap">{detail}</pre>
    </details>
  );
}

const deviceKey = (device: HubDevice) => device.platform + ":" + device.id;

type ReportDevice = (device: HubDevice | null) => void;

function Screen({
  session,
  device,
  onDisplay,
}: {
  session: string | null;
  device: HubDevice;
  onDisplay: ReportDevice;
}) {
  const client = useDeviceClient();
  const screen = useDeviceScreenClient();
  useEffect(() => {
    if (!screen.framePresented) return;
    onDisplay(device);
  }, [device, onDisplay, screen.framePresented]);
  const size = displayScreen(screen.screen);
  const ratio = size ? size.width / size.height : 9 / 19.5;
  const capture = useMutation({
    mutationFn: async () => {
      if (!session) return;
      const target = composerTarget(session);
      const shot = await client.screenshot({ format: "png" });
      if (!shot) throw new Error("The device could not capture a screenshot.");
      const attached = await attachImageFiles(target, [
        new File([shot.blob], "device-screenshot.png", { type: shot.blob.type }),
      ]);
      if (!attached) throw new Error("The screenshot could not be added to the chat.");
    },
  });
  return (
    <>
      <div className="border-border-subtle flex items-center justify-end gap-1 border-b px-2 py-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={!screen.framePresented}
          onClick={() => client.pressButton("home")}
        >
          <House />
          Home
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!session || !screen.framePresented || capture.isPending}
          onClick={() => capture.mutate()}
        >
          <Camera />
          Screenshot
        </Button>
      </div>
      {capture.error && (
        <p role="alert" className="text-destructive px-3 text-sm">
          {getErrorMessage(capture.error)}
        </p>
      )}
      <div className="[container-type:size] m-3 grid min-h-0 flex-1 place-items-center">
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
    </>
  );
}

function Devices({
  workspaceId,
  session,
  instance,
  onDisplay,
}: {
  onDisplay: ReportDevice;
  workspaceId: string;
  session: string | null;
  instance: string;
}) {
  const cache = useQueryClient();
  const savedKey = ["deviceHubSelection", workspaceId];
  const [active, setActive] = useState(() =>
    cache.getQueryData<{ device: HubDevice; instance: string }>(savedKey)
  );
  const [platform, setPlatform] = useState<HubDevice["platform"]>(active?.device.platform ?? "ios");
  const [id, setId] = useState(active ? deviceKey(active.device) : "");
  const restoring = active && active.instance !== instance;
  const list = useQuery({
    queryKey: ["deviceHubDevices", instance],
    queryFn: () => call(api.deviceHubDevices),
    // A replacement hub can answer its first inventory while the device is still booting.
    refetchInterval: (query) =>
      restoring && !query.state.data?.devices.some((d) => d.booted && deviceKey(d) === id)
        ? 2500
        : false,
  });
  const endpoints = useQuery({
    queryKey: ["deviceHubEndpoints", instance],
    queryFn: () => resolveBackendEndpoints(),
  });
  const start = useMutation({
    mutationFn: ({ device, boot }: { device: HubDevice; boot: boolean }) =>
      call(
        api.startHubDevice,
        { platform: device.platform, id: device.id, boot },
        { timeoutMs: 410_000 }
      ),
    onSuccess(device) {
      const connected = { device, instance };
      cache.setQueryData(savedKey, connected);
      setActive(connected);
      setId(deviceKey(device));
      void list.refetch();
    },
  });
  const devices = list.data?.devices.filter((d) => d.platform === platform) ?? [];
  const selected = devices.find((d) => deviceKey(d) === id);
  const viewing =
    active?.instance === instance && deviceKey(active.device) === id && selected?.booted;
  const reconnect = restoring && selected?.booted ? selected : null;
  const attempted = useRef<string | null>(null);
  const { mutate: connect } = start;
  useEffect(() => {
    if (!reconnect || attempted.current === reconnect.id) return;
    attempted.current = reconnect.id;
    connect({ device: reconnect, boot: false });
  }, [connect, reconnect]);
  function select(value: string) {
    setId(value);
    setActive(undefined);
    onDisplay(null);
    cache.removeQueries({ queryKey: savedKey, exact: true });
    start.reset();
  }
  const failure = list.error ?? start.error ?? endpoints.error;
  let placeholder = "Choose a device";
  if (list.isPending) placeholder = "Finding devices…";
  else if (!devices.length) placeholder = "No devices found";
  return (
    <>
      <Tabs
        aria-label="Device platform"
        value={platform}
        onValueChange={(value) => {
          setPlatform(value === "android" ? "android" : "ios");
          select("");
        }}
      >
        <TabsList className="mx-2 mt-2">
          <TabsTrigger value="ios" disabled={start.isPending}>
            iOS
          </TabsTrigger>
          <TabsTrigger value="android" disabled={start.isPending}>
            Android
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="border-border-subtle flex min-w-0 items-center gap-2 border-b p-2">
        <Select
          value={id}
          disabled={start.isPending}
          onOpenChange={(open) => {
            if (open) void list.refetch();
          }}
          onValueChange={select}
        >
          <SelectTrigger size="sm" aria-label="Device" className="min-w-0 flex-1">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {devices.map((device) => (
              <SelectItem key={device.id} value={deviceKey(device)}>
                {device.name} · {device.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="secondary"
          disabled={!selected || !!viewing || start.isPending}
          onClick={() => selected && start.mutate({ device: selected, boot: true })}
        >
          <Play />
          {start.isPending ? "Starting…" : "Start"}
        </Button>
      </div>
      {failure && (
        <div role="alert" className="text-destructive p-3 text-sm">
          {getErrorMessage(failure)}{" "}
          {list.error && (
            <Button variant="link" size="xs" onClick={() => void list.refetch()}>
              Retry
            </Button>
          )}
          <DeviceDetails
            detail={
              failure instanceof OpError && typeof failure.details === "string"
                ? failure.details
                : null
            }
          />
        </div>
      )}
      {viewing && endpoints.data && (
        <DeviceClientProvider
          platform={active.device.platform}
          options={{
            baseUrl:
              endpoints.data.apiBase +
              "/device-hub/vendor/" +
              (active.device.platform === "ios" ? "serve-sim" : "serve-emu"),
            device: active.device.id,
            streamMode: HUB_STREAM_MODE,
          }}
        >
          <Screen session={session} device={active.device} onDisplay={onDisplay} />
        </DeviceClientProvider>
      )}
      {devices.length > 0 && !selected && (
        <p className="text-muted-foreground m-auto p-4 text-center text-sm">
          Choose a device, then select Start.
        </p>
      )}
      {list.data && !devices.length && (
        <div className="text-muted-foreground m-auto max-w-xs p-4 text-center text-sm">
          {platform === "ios" ? (
            list.data.available.ios ? (
              <p>
                Create an iOS Simulator in Xcode’s Window → Devices and Simulators, then open the
                device picker.
              </p>
            ) : (
              <>
                <p>iOS Simulators need Xcode.</p>
                <DeviceSetupLink platform="ios" />
              </>
            )
          ) : (
            <>
              {!list.data.available.android && <p>Android emulators need the Android SDK.</p>}
              {list.data.available.android ? (
                <p>
                  Create a virtual device in Android Studio’s Device Manager, start it there, then
                  open the device picker.
                </p>
              ) : (
                <DeviceSetupLink platform="android" />
              )}
            </>
          )}
          <DeviceDetails detail={list.data.detail[platform]} />
        </div>
      )}
    </>
  );
}

export default function DevicePanel({
  workspaceId,
  defaultSession,
}: {
  workspaceId: string;
  defaultSession: string | null;
}) {
  const activeSession = useWorkspaceLayoutStore(
    (s) => s.layouts[workspaceId]?.activeChatTabSessionId
  );
  const [status, setStatus] = useState<HubStatus>({ phase: "idle" });
  const [shown, setShown] = useState<HubDevice | null>(null);
  useStream(
    api.deviceHubStatus,
    {
      workspaceId,
      platform: shown?.platform ?? null,
      deviceId: shown?.id ?? null,
    },
    setStatus
  );
  const retry = useMutation({ mutationFn: () => call(api.retryDeviceHub) });
  return (
    <section
      aria-label="Device panel"
      className="bg-background text-foreground flex h-full min-h-0 flex-col"
    >
      {status.phase === "ready" ? (
        <Devices
          key={status.instance}
          workspaceId={workspaceId}
          session={activeSession ?? defaultSession}
          instance={status.instance}
          onDisplay={setShown}
        />
      ) : (
        <div role="status" className="text-muted-foreground m-auto p-4 text-center text-sm">
          {status.phase === "error" ? (
            <>
              {status.message}{" "}
              <Button size="xs" variant="link" onClick={() => retry.mutate()}>
                Retry
              </Button>
              <DeviceDetails detail={status.detail} />
            </>
          ) : status.phase === "installing" ? (
            "Setting up devices…"
          ) : (
            "Starting devices…"
          )}
        </div>
      )}
    </section>
  );
}
