import { useCallback, useEffect, useState } from "react";
import { mutationOptions, useMutation, useQuery } from "@tanstack/react-query";
import * as api from "@shared/api/device-hub";
import { deviceIdentity, type HubDevice } from "@shared/types/device-hub";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
} from "@/features/workspace/store/workspaceLayoutStore";
import { getBaseURL } from "@/shared/config/api.config";
import { call } from "@/platform/ws";
import { canClearMissingDevice, deviceKey } from "./devices";

const recoveryMs = 30_000;

export type Attachment = {
  workspaceId: string;
  instance: string;
  device: HubDevice;
  baseUrl: string;
};

export function startDeviceOptions(workspaceId: string, instance: string) {
  return mutationOptions({
    mutationFn: async ({ device, boot }: { device: HubDevice; boot: boolean }) => {
      const [connected, apiBase] = await Promise.all([
        call(
          api.startHubDevice,
          { platform: device.platform, identity: deviceIdentity(device), boot },
          { timeoutMs: boot ? 410_000 : recoveryMs }
        ),
        getBaseURL(),
      ]);
      const vendor = connected.platform === "ios" ? "serve-sim" : "serve-emu";
      return {
        workspaceId,
        instance,
        device: connected,
        baseUrl: apiBase + "/device-hub/vendor/" + vendor,
      };
    },
    onSuccess({ workspaceId, device }) {
      const choice = workspaceLayoutActions.getLayout(workspaceId).deviceChoice;
      if (choice?.key === deviceKey(device) && !choice.started) {
        workspaceLayoutActions.setLayout(workspaceId, {
          deviceChoice: { ...choice, started: true },
        });
      }
    },
  });
}

export function useDeviceSelection(
  workspaceId: string,
  instance: string,
  attached: Attachment | null,
  onAttach: (attachment: Attachment | null) => void
) {
  const choice = useWorkspaceLayoutStore((state) => state.layouts[workspaceId]?.deviceChoice);
  const id = choice?.key;
  // On return, a previous Start may still be pending. Starting here clears "restore".
  const [deadline, setDeadline] = useState<number | "restore" | null>("restore");
  if (deadline === "restore" && choice?.started) setDeadline(() => Date.now() + recoveryMs);
  const recoverUntil = choice?.started && typeof deadline === "number" ? deadline : null;
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
  const start = useMutation(startDeviceOptions(workspaceId, instance));
  const { mutate, reset } = start;
  const { refetch } = list;
  const attach = useCallback(
    (device: HubDevice, boot: boolean) => {
      mutate(
        { device, boot },
        {
          onSuccess: onAttach,
          onSettled() {
            setDeadline(null);
            void refetch();
          },
        }
      );
    },
    [mutate, onAttach, refetch]
  );
  const choose = useCallback(
    (key: string | null) => {
      workspaceLayoutActions.setLayout(workspaceId, {
        deviceChoice: key ? { key, started: false } : null,
      });
      onAttach(null);
      reset();
    },
    [onAttach, reset, workspaceId]
  );
  const inventory = list.data;
  const devices =
    inventory?.devices.filter((d) => d.platform === "ios" || inventory.available.android) ?? [];
  const selected = devices.find((d) => deviceKey(d) === id);
  const viewing =
    selected?.booted && attached?.device.id === selected.id && deviceKey(attached.device) === id
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
      if (canClearMissingDevice(id, list.data.detail)) choose(null);
    } else if (recoverUntil && Date.now() < recoverUntil && selected.booted && start.isIdle) {
      attach(selected, false);
    }
  }, [
    attach,
    id,
    list.data,
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
