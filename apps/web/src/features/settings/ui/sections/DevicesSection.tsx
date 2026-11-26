import type { ReactNode } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { deviceSetup, retryDeviceHub } from "@shared/api/device-hub";
import type { DeviceSetup, DeviceSupport } from "@shared/types/device-hub";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import { useDeviceSupport } from "@/features/device/useDeviceSupport";
import { DeviceSetupLink } from "@/features/device/DeviceSetupLink";
import { call } from "@/platform/ws";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";

function Row({
  label,
  status,
  detail,
  ready = false,
}: {
  label: string;
  status: ReactNode;
  detail?: ReactNode;
  ready?: boolean;
}) {
  const Icon = ready ? CheckCircle2 : Circle;
  return (
    <div className="border-border-subtle flex flex-wrap items-center justify-between gap-x-5 gap-y-2 rounded-lg border p-4">
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium">{label}</h4>
        {detail && <div className="text-muted-foreground mt-1 text-sm">{detail}</div>}
      </div>
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <Icon aria-hidden className={ready ? "text-accent-green size-4" : "size-3.5"} />
        {status}
      </div>
    </div>
  );
}

function tabStatus(liveView: DeviceSupport["liveView"], setup: DeviceSetup["setup"] | undefined) {
  if (liveView === "unsupported") return "Needs a Mac with Apple silicon";
  if (liveView === "no-runtime") return "Device runtime unavailable";
  if (!setup) return "Checking setup…";
  return {
    ready: "Ready",
    new: "Sets up the first time you open it",
    working: "Setting up devices…",
    failed: "Setup failed",
  }[setup];
}

export function DevicesSection() {
  const support = useDeviceSupport();
  const data = support.data;
  const enabled = data?.liveView === "available";
  const queryKey = [deviceSetup.name];
  useQuerySubscription(deviceSetup, { queryKey, enabled });
  const setup = useQuery({
    queryKey,
    queryFn: () => call(deviceSetup),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const retry = useMutation({ mutationFn: () => call(retryDeviceHub) });
  return (
    <section className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Devices</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Watch and control iOS Simulators and Android emulators next to your chat. Agents can test
          your app on the same devices.
        </p>
      </div>
      {data?.liveView === "remote" ? (
        <Row label="Device tab" status="The Device tab works in Deus on the Mac itself." />
      ) : data ? (
        <div className="space-y-3">
          <Row
            label="Device tab"
            ready={enabled && setup.data?.setup === "ready"}
            status={
              setup.error && enabled
                ? getErrorMessage(setup.error)
                : tabStatus(data.liveView, setup.data?.setup)
            }
            detail={
              <>
                Open it from New Tab → Device.
                <span className="text-text-muted mt-0.5 block text-xs">
                  Expo Device Hub {data.hubVersion}
                </span>
                {enabled && setup.data?.setup === "failed" && (
                  <>
                    {setup.data.error && (
                      <p className="mt-1 whitespace-pre-wrap">{setup.data.error}</p>
                    )}
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate()}
                    >
                      Retry
                    </Button>
                  </>
                )}
              </>
            }
          />
          <Row
            label="iOS Simulators"
            ready={data.xcode.available}
            status={data.xcode.available ? "Ready" : <DeviceSetupLink platform="ios" />}
            detail={data.xcode.version && "Xcode " + data.xcode.version}
          />
          <Row
            label="Android emulators"
            ready={data.android}
            status={data.android ? "Ready" : <DeviceSetupLink platform="android" />}
          />
          <Row
            label="Agents can use devices"
            ready
            status="Built in"
            detail={`Agents open apps, tap and check screens with agent-device ${data.agentDeviceVersion}. They use the device your Device tab shows.`}
          />
        </div>
      ) : (
        <p role="status" className="text-muted-foreground text-sm">
          {support.error ? getErrorMessage(support.error) : "Checking this computer…"}
        </p>
      )}
      {retry.error && (
        <p role="alert" className="text-destructive text-sm">
          {getErrorMessage(retry.error)}
        </p>
      )}
    </section>
  );
}
