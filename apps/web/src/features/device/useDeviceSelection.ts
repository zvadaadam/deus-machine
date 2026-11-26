import { useCallback, useEffect, useState } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "@shared/api/device-hub";
import { deviceIdentity, type HubDevice } from "@shared/types/device-hub";
import { call } from "@/platform/ws";
import { deviceKey } from "./devices";

const recoveryMs = 30_000;

export type Attachment = { workspaceId: string; instance: string; device: HubDevice };

export function useDeviceSelection(
  workspaceId: string,
  instance: string,
  attached: HubDevice | null,
  onAttach: (attachment: Attachment | null) => void
) {
  const cache = useQueryClient();
  const { data: choice } = useQuery<{ key: string; started: boolean } | null>({
    queryKey: ["deviceHubSelection", workspaceId],
    queryFn: skipToken,
    initialData: null,
  });
  const id = choice?.key;
  const [deadline, setDeadline] = useState(() =>
    choice?.started ? Date.now() + recoveryMs : null
  );
  const recoverUntil = choice?.started ? deadline : null;
  const list = useQuery({
    queryKey: ["deviceHubDevices", instance],
    queryFn: () => call(api.deviceHubDevices),
    refetchOnMount: "always",
    retry: false,
    refetchInterval: (q) => {
      if (!recoverUntil || Date.now() >= recoverUntil) return false;
      const device = q.state.data?.devices.find((d) => deviceKey(d) === id);
      return q.state.error || (device && !device.booted) ? 2500 : false;
    },
  });
  const start = useMutation({
    mutationFn: ({ device, boot }: { device: HubDevice; boot: boolean }) =>
      call(
        api.startHubDevice,
        { platform: device.platform, identity: deviceIdentity(device), boot },
        { timeoutMs: boot ? 410_000 : recoveryMs }
      ),
  });
  const { mutate, reset } = start;
  const { refetch } = list;
  const attach = useCallback(
    (device: HubDevice, boot: boolean) => {
      mutate(
        { device, boot },
        {
          onSuccess(connected) {
            cache.setQueryData(["deviceHubSelection", workspaceId], {
              key: deviceKey(connected),
              started: true,
            });
            onAttach({ workspaceId, instance, device: connected });
          },
          onSettled() {
            setDeadline(null);
            void refetch();
          },
        }
      );
    },
    [cache, instance, mutate, onAttach, refetch, workspaceId]
  );
  const choose = useCallback(
    (key: string | null) => {
      cache.setQueryData(["deviceHubSelection", workspaceId], key ? { key, started: false } : null);
      onAttach(null);
      reset();
    },
    [cache, onAttach, reset, workspaceId]
  );
  const inventory = list.data;
  const devices =
    inventory?.devices.filter((d) => d.platform === "ios" || inventory.available.android) ?? [];
  const selected = devices.find((d) => deviceKey(d) === id);
  const viewing =
    selected?.booted && attached?.id === selected.id && deviceKey(attached) === id
      ? attached
      : null;

  useEffect(() => {
    if (!recoverUntil) return;
    const timer = setTimeout(
      () => {
        reset();
        setDeadline(null);
      },
      Math.max(0, recoverUntil - Date.now())
    );
    return () => clearTimeout(timer);
  }, [recoverUntil, reset]);
  useEffect(() => {
    if (!list.isSuccess || !list.isFetchedAfterMount || !id) return;
    if (!selected) {
      choose(null);
    } else if (recoverUntil && Date.now() < recoverUntil && selected.booted && start.isIdle) {
      attach(selected, false);
    }
  }, [
    attach,
    id,
    list.isSuccess,
    list.isFetchedAfterMount,
    recoverUntil,
    choose,
    selected,
    start.isIdle,
  ]);
  const reconnect = useCallback(() => {
    onAttach(null);
    reset();
    setDeadline(Date.now() + recoveryMs);
    void refetch();
  }, [onAttach, refetch, reset]);
  return {
    list,
    devices,
    selected,
    viewing,
    recovering: recoverUntil !== null,
    starting: start.isPending,
    error: start.error,
    reconnect,
    select(key: string) {
      if (key !== id) {
        setDeadline(null);
        choose(key);
      }
    },
    start() {
      if (selected) {
        setDeadline(null);
        attach(selected, true);
      }
    },
  };
}
