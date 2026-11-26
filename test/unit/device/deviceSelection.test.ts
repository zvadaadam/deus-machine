import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { HubDevice } from "@shared/types/device-hub";
import { deviceHubDevices } from "@shared/api/device-hub";
import { deviceKey } from "@/features/device/devices";
import { startDeviceOptions, useDeviceSelection } from "@/features/device/useDeviceSelection";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";

const call = vi.hoisted(() => {
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      HTMLIFrameElement: class {},
      localStorage: { getItem: () => null, setItem: () => {} },
    })
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return vi.fn();
});
vi.mock("@/platform/ws", () => ({ call }));
vi.mock("@/shared/config/api.config", () => ({ getBaseURL: async () => "http://localhost/api" }));

const device: HubDevice = {
  platform: "ios",
  id: "A0-B0",
  name: "iPhone",
  version: "27",
  booted: false,
};
const chosen = { key: deviceKey(device), started: false };
const replacement = { key: "ios:C0-D0", started: false };

beforeEach(() => {
  workspaceLayoutActions.resetAll();
  call.mockReset();
});
afterAll(() => vi.unstubAllGlobals());

it.each([
  ["remembers the Start", chosen, { ...chosen, started: true }],
  ["keeps a replacement choice", replacement, replacement],
  ["keeps a cleared choice", null, null],
] as const)("%s when the boot finishes without a mounted panel", async (_, choice, expected) => {
  const client = new QueryClient();
  const boot = Promise.withResolvers<HubDevice>();
  call.mockReturnValueOnce(boot.promise);
  workspaceLayoutActions.setLayout("origin", { deviceChoice: chosen });
  workspaceLayoutActions.setLayout("other", { deviceChoice: chosen });
  const mutation = client.getMutationCache().build(client, startDeviceOptions("origin", "hub"));
  const finished = mutation.execute({ device, boot: true });
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  workspaceLayoutActions.setLayout("origin", { deviceChoice: choice });
  boot.resolve({ ...device, booted: true });
  await finished;
  expect(workspaceLayoutActions.getLayout("origin").deviceChoice).toEqual(expected);
  expect(workspaceLayoutActions.getLayout("other").deviceChoice).toEqual(chosen);
  client.clear();
});

it.each([
  ["attaches its own Start without entering recovery", false],
  ["recovers a Start that finishes after the panel reopens", true],
] as const)("%s", async (_, reopen) => {
  const root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  const client = new QueryClient();
  const boot = Promise.withResolvers<HubDevice>();
  const running = { ...device, booted: true };
  let listed = device;
  const inventory = () => ({
    devices: [listed],
    available: { ios: true, android: false },
    detail: { ios: null, android: null },
  });
  client.setQueryData([deviceHubDevices.name, "hub"], inventory());
  workspaceLayoutActions.setLayout("origin", { deviceChoice: chosen });
  call.mockImplementation(async (op, params) => {
    if (op === deviceHubDevices) return inventory();
    return params.boot ? boot.promise : running;
  });
  const onAttach = vi.fn();
  const recovering: boolean[] = [];
  let selection: ReturnType<typeof useDeviceSelection>;
  function Panel() {
    selection = useDeviceSelection("origin", "hub", null, onAttach);
    recovering.push(selection.recovering);
    return null;
  }
  const mount = () =>
    act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Panel)));
    });
  try {
    await mount();
    await act(async () => selection.start());
    if (reopen) {
      await act(async () => root.render(null));
      listed = running;
      await mount();
      expect(onAttach).not.toHaveBeenCalled();
    }
    await act(async () => boot.resolve(running));
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(onAttach).toHaveBeenCalledOnce();
    });
    expect(onAttach.mock.calls[0][0]).toMatchObject({ workspaceId: "origin", device: running });
    expect(recovering.includes(true)).toBe(reopen);
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
