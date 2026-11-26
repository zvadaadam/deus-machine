import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { DeviceClientProvider } from "@expo/hub-client";
import * as api from "@shared/api/device-hub";
import {
  HUB_STREAM_MODE,
  type HubDevice,
  type HubInventory,
  type HubStatus,
} from "@shared/types/device-hub";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import { call, OpError } from "@/platform/ws";
import { resolveBackendEndpoints } from "@/shared/config/backend.config";
import { useStream } from "@/shared/hooks/useStream";
import { useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";
import { DevicePicker } from "./DevicePicker";
import { DeviceActions, DeviceView } from "./DeviceView";
import { DeviceSetupLink } from "./DeviceSetupLink";
import { deviceKey, deviceSetup } from "./devices";

function DeviceDetails({ detail }: { detail?: string | null }) {
  if (!detail) return null;
  return (
    <details className="text-muted-foreground mt-1 text-left text-xs">
      <summary className="cursor-pointer">Technical details</summary>
      <pre className="mt-1 max-h-28 overflow-auto break-words whitespace-pre-wrap">{detail}</pre>
    </details>
  );
}

function EmptyDevices({ inventory }: { inventory: HubInventory }) {
  return (
    <div className="text-muted-foreground m-auto max-w-xs space-y-2 p-4 text-center text-sm">
      {inventory.available.ios ? (
        <p>{deviceSetup.ios.create}</p>
      ) : (
        <div>
          <p>iOS Simulators need Xcode.</p>
          <DeviceSetupLink platform="ios" />
        </div>
      )}
      <DeviceDetails detail={inventory.detail.ios} />
      {inventory.available.android && (
        <>
          <p>{deviceSetup.android.create}</p>
          <DeviceDetails detail={inventory.detail.android} />
        </>
      )}
    </div>
  );
}

function Devices({
  workspaceId,
  session,
  instance,
  onDisplay,
}: {
  onDisplay: (device: HubDevice | null) => void;
  workspaceId: string;
  session: string | null;
  instance: string;
}) {
  const cache = useQueryClient();
  const savedKey = ["deviceHubSelection", workspaceId];
  const [active, setActive] = useState(() =>
    cache.getQueryData<{ device: HubDevice; instance: string }>(savedKey)
  );
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
  const inventory = list.data;
  const devices =
    inventory?.devices.filter((d) => d.platform === "ios" || inventory.available.android) ?? [];
  const selected = devices.find((d) => deviceKey(d) === id);
  const viewing =
    active?.instance === instance && deviceKey(active.device) === id && selected?.booted
      ? active.device
      : undefined;
  const reconnect = restoring && selected?.booted ? selected : null;
  const attempted = useRef<string | null>(null);
  const { mutate: connect } = start;
  useEffect(() => {
    if (!reconnect || attempted.current === reconnect.id) return;
    attempted.current = reconnect.id;
    connect({ device: reconnect, boot: false });
  }, [connect, reconnect]);
  function select(value: string) {
    if (value === id) return;
    setId(value);
    setActive(undefined);
    onDisplay(null);
    cache.removeQueries({ queryKey: savedKey, exact: true });
    start.reset();
  }
  const failure = list.error ?? start.error ?? endpoints.error;
  return (
    <DeviceClientProvider
      platform={viewing?.platform ?? null}
      options={{
        baseUrl:
          viewing && endpoints.data
            ? endpoints.data.apiBase +
              "/device-hub/vendor/" +
              (viewing.platform === "ios" ? "serve-sim" : "serve-emu")
            : null,
        device: viewing?.id,
        streamMode: HUB_STREAM_MODE,
      }}
    >
      <div
        role="group"
        aria-label="Device controls"
        className="border-border-subtle flex min-w-0 shrink-0 items-center gap-1.5 border-b p-2"
      >
        <DevicePicker
          inventory={inventory}
          selected={selected}
          disabled={start.isPending}
          onOpen={() => void list.refetch()}
          onSelect={select}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!selected || !!viewing || start.isPending}
          onClick={() => selected && start.mutate({ device: selected, boot: true })}
        >
          <Play />
          {start.isPending ? "Starting…" : "Start"}
        </Button>
        <DeviceActions session={session} />
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
      {inventory && !failure && !devices.length && <EmptyDevices inventory={inventory} />}
      {!failure && devices.length > 0 && (!selected || restoring) && (
        <p className="text-muted-foreground m-auto p-4 text-center text-sm">
          {restoring ? "Reconnecting to the device…" : "Choose a device, then select Start."}
        </p>
      )}
      {viewing && endpoints.data && <DeviceView device={viewing} onDisplay={onDisplay} />}
    </DeviceClientProvider>
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
      className="bg-background text-foreground @container flex h-full min-h-0 flex-col"
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
