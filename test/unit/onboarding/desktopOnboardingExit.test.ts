import { act, createElement, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import type { MotionProps } from "framer-motion";
import { toast } from "sonner";
import { expect, it, onTestFinished, vi } from "vitest";
import { api } from "@shared/api";
import { DesktopShell } from "@/app/shells/DesktopShell";
import { requestAgentInstall } from "@/features/settings/lib/local-agent-installs";
import { RuntimeClient } from "@/platform/ws/runtime-client";
import { queryClient, setActiveQueryClient } from "@/shared/api/queryClient";
import { queryKeys } from "@/shared/api/queryKeys";
import { tempo } from "@/shared/lib/tempo";
import { Socket } from "../../../packages/runtime-client/test/socket";

const { enter, leave, show, fade } = vi.hoisted(() => ({
  enter: vi.fn(async () => {}),
  leave: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  fade: vi.fn<(exit: MotionProps["exit"], finish: () => void) => void>(),
}));

// AnimatePresence owns the real mount. Let the test finish the frame that animates the overlay.
vi.mock("framer-motion", async (original) => {
  const motion = await original<typeof import("framer-motion")>();
  function Frame({ exit }: MotionProps) {
    const [present, finish] = motion.usePresence();
    if (!present && finish) fade(exit, finish);
    return null;
  }
  return { ...motion, m: { ...motion.m, div: Frame } };
});
vi.mock("@/platform", () => ({
  native: {
    window: {
      enterOnboarding: enter,
      exitOnboarding: leave,
      show,
      hasRevealedWindow: () => enter.mock.calls.length > 0,
    },
  },
}));
vi.mock("@/features/settings", () => import("@/features/settings/api/settings.queries"));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: () => false }));
vi.mock("@/app/layouts/MainLayout", () => ({ MainLayout: () => null }));
vi.mock("@/app/providers/ThemeProvider", () => ({ useTheme: () => ({ preference: "system" }) }));
vi.mock("@/features/auth", () => ({ useAuth: () => ({ hasDeviceGrant: true }) }));
vi.mock("@/shared/components", () => ({ DashboardError: () => null }));
vi.mock("@/shared/utils/errorReporting", () => ({ createBoundaryErrorHandler: vi.fn() }));
vi.mock("@/platform/analytics", () => ({ track: vi.fn(), reportTheme: vi.fn() }));
vi.mock("@/platform/notifications", () => ({ initNotifications: vi.fn() }));
vi.mock("@/features/session/hooks/useGlobalSessionNotifications", () => ({
  useGlobalSessionNotifications: vi.fn(),
}));
vi.mock("@/features/workspace/hooks/useOpenWorkspaceLink", () => ({
  useOpenWorkspaceLink: vi.fn(),
}));
vi.mock("@/features/session/hooks/useAgentEvents", () => ({ useAgentEvents: vi.fn() }));
vi.mock("@/shared/hooks/useQueryProtocol", () => ({ useQueryProtocol: vi.fn() }));
vi.mock("@/shared/hooks/useBackendRestart", () => ({ useBackendRestart: vi.fn() }));
vi.mock("@/features/updates", () => ({
  useAutoUpdate: vi.fn(),
  useUpdateToast: vi.fn(),
  UpdateProvider: ({ children }: PropsWithChildren) => children,
}));

async function mountOnboarding() {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  const socket = new Socket();
  const runtime = new RuntimeClient(
    { host: "mac", account: "a", grant: "local" },
    { open: () => socket, heartbeatIntervalMs: 0 }
  );
  const previous = queryClient;
  setActiveQueryClient(runtime.queryClient);
  onTestFinished(() => {
    act(() => root.unmount());
    runtime.dispose();
    setActiveQueryClient(previous);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  const connected = runtime.connect();
  await Promise.resolve();
  socket.open();
  socket.message({ type: "connected" });
  await connected;
  runtime.queryClient.setQueryData(queryKeys.settings.all, { onboarding_completed: false });
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: runtime.queryClient },
        createElement(DesktopShell, { reset: vi.fn() })
      )
    )
  );
  const id = socket.frames("q:subscribe").find((frame) => frame.resource === "settings")!.id;
  const push = (completed: boolean) =>
    act(async () => {
      socket.message({ type: "q:snapshot", id, data: { onboarding_completed: completed } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { runtime, socket, push };
}

it("holds onboarding through its exit after a settings push, then allows Settings to replay it", async () => {
  const { runtime, socket, push } = await mountOnboarding();
  expect(enter).toHaveBeenCalledOnce();
  const saving = runtime.call(api.saveSetting, { key: "onboarding_completed", value: true });
  await push(true);
  const animation = fade.mock.lastCall;
  socket.message({ type: "q:mutate_result", id: socket.frames("q:mutate")[0].id, success: true });
  await saving;
  expect(leave).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
  const [exit, finish] = animation!;
  expect(exit).toEqual({ opacity: 0, transition: tempo.slow.exit });
  act(finish);
  expect(leave).toHaveBeenCalledOnce();
  await push(false);
  expect(enter).toHaveBeenCalledTimes(2);
  expect(leave).toHaveBeenCalledOnce();
  expect(show).not.toHaveBeenCalled();
});

it("reports an install failure once as onboarding hands off to the main layout", async () => {
  const { runtime, socket, push } = await mountOnboarding();
  const error = vi.spyOn(toast, "error");
  onTestFinished(() => error.mockRestore());
  const resource = api.agentCliProgress.name;
  const subscriptions = () => socket.frames("q:subscribe").filter((f) => f.resource === resource);
  expect(subscriptions()).toHaveLength(1);
  const [subscription] = subscriptions();
  requestAgentInstall(runtime.queryClient, "gemini");
  await push(true);
  const [, finish] = fade.mock.lastCall!;
  socket.message({
    type: "q:event",
    id: subscription.id,
    event: resource,
    data: {
      harness: "gemini",
      phase: "failed",
      error: "Download failed",
      receivedBytes: 0,
      version: "1",
    },
  });
  act(finish);
  expect(error).toHaveBeenCalledExactlyOnceWith("Couldn’t install Gemini: Download failed", {
    id: "cli-install-gemini",
  });
  expect(subscriptions()).toEqual([subscription]);
  expect(socket.frames("q:unsubscribe")).not.toContainEqual(
    expect.objectContaining({ id: subscription.id })
  );
});
