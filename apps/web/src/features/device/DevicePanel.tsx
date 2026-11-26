import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { useDeviceSelection, type Attachment } from "./useDeviceSelection";
import { deviceSetup } from "./devices";

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
  attached,
  onAttach,
  onDisplay,
}: {
  attached: HubDevice | null;
  onAttach: (attachment: Attachment | null) => void;
  onDisplay: (device: HubDevice | null) => void;
  workspaceId: string;
  session: string | null;
  instance: string;
}) {
  const selection = useDeviceSelection(workspaceId, instance, attached, onAttach);
  const { list, selected, viewing } = selection;
  const inventory = list.data;
  const endpoints = useQuery({
    queryKey: ["deviceHubEndpoints", instance],
    queryFn: () => resolveBackendEndpoints(),
  });
  const failure = list.error ?? selection.error ?? endpoints.error;
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
          disabled={selection.starting}
          onOpen={() => void list.refetch()}
          onSelect={selection.select}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!selected || !!viewing || selection.starting}
          onClick={selection.start}
        >
          <Play />
          {selection.starting ? "Starting…" : "Start"}
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
      {inventory && !failure && !selection.devices.length && <EmptyDevices inventory={inventory} />}
      {!failure && selection.devices.length > 0 && (!selected || selection.recovering) && (
        <p className="text-muted-foreground m-auto p-4 text-center text-sm">
          {selection.recovering
            ? "Reconnecting to the device…"
            : "Choose a device, then select Start."}
        </p>
      )}
      {viewing && endpoints.data && (
        <DeviceView device={viewing} onDisplay={onDisplay} onReconnect={selection.reconnect} />
      )}
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
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const attached =
    status.phase === "ready" &&
    attachment?.instance === status.instance &&
    attachment.workspaceId === workspaceId
      ? attachment.device
      : null;
  const [shown, setShown] = useState<HubDevice | null>(null);
  useStream(
    api.deviceHubStatus,
    {
      workspaceId,
      platform: attached?.platform ?? null,
      deviceId: attached?.id ?? null,
      displayedInstance:
        status.phase === "ready" && attached && shown === attached ? status.instance : null,
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
          key={workspaceId + ":" + status.instance}
          workspaceId={workspaceId}
          session={activeSession ?? defaultSession}
          instance={status.instance}
          attached={attached}
          onAttach={setAttachment}
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
