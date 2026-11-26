import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// What a click on an address in the chat does before anything is awaited: a
// browser allows a new tab only while it handles the click.
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  onConnectionChange: vi.fn<(handler: (online: boolean) => void) => void>(),
  runtimeState: vi.fn(() => "online"),
  openExternal: vi.fn(async () => {}),
  openExternalPending: vi.fn(),
  toast: vi.fn(),
}));
vi.hoisted(() =>
  vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => {} } })
);
vi.mock("@/platform/ws", () => ({
  call: mocks.call,
  follow: vi.fn(),
  isConnected: () => true,
  onConnectionChange: mocks.onConnectionChange,
  getRuntimeClient: () => ({ call: mocks.call, getState: mocks.runtimeState }),
}));
vi.mock("@/platform/native", () => ({
  native: {
    window: {
      openExternal: mocks.openExternal,
      openExternalPending: mocks.openExternalPending,
    },
  },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/shared/hooks/use-mobile", () => ({ isMobileViewport: vi.fn(() => false) }));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: () => false }));

import { openAddressFromChat, runChatAction } from "@/features/session/lib/openFromChat";
import {
  ensureCloudPreviewSubscription,
  useCloudPreviewStore,
} from "@/features/browser/cloud/cloudPreviewStore";
import { CLOUD_LOCALHOST } from "@/features/workspace/lib/reach";
import { isMobileViewport } from "@/shared/hooks/use-mobile";
import {
  workspaceLayoutActions,
  resolveWorkspaceTabs,
} from "@/features/workspace/store/workspaceLayoutStore";

const cloud = { cloud: true, folder: null };
const TEMPLATE = "https://{{port}}-sbx.e2b.app";

function reservedTab() {
  const tab = { open: vi.fn(async () => {}), cancel: vi.fn() };
  mocks.openExternalPending.mockReturnValue(tab);
  return tab;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeState.mockReturnValue("online");
  workspaceLayoutActions.resetAll();
  // This window has not heard the computer's preview address.
  useCloudPreviewStore.setState({ byWorkspace: {}, pending: null, generation: 0 });
});
afterAll(() => vi.unstubAllGlobals());

describe("an address clicked in a cloud chat", () => {
  it("opens an internet address in the click itself, with no preview request", async () => {
    const done = openAddressFromChat("ws-1", "https://example.com/x", cloud);
    // Synchronously, before the click's handler has awaited anything.
    expect(mocks.openExternal).toHaveBeenCalledWith("https://example.com/x");
    await done;
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.openExternalPending).not.toHaveBeenCalled();
  });

  it("opens a card's internet address the same way", async () => {
    const done = runChatAction(
      "ws-1",
      { kind: "system-browser", label: "Open in External Browser", url: "https://example.com/x" },
      cloud
    );
    expect(mocks.openExternal).toHaveBeenCalledWith("https://example.com/x");
    await done;
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("opens a typed localhost address in the cloud preview in place of its New Tab", async () => {
    const launcher = resolveWorkspaceTabs(workspaceLayoutActions.getLayout("ws-1")).activeTabId;
    mocks.runtimeState.mockReturnValue("connecting");
    const opening = openAddressFromChat("ws-1", "http://localhost:5173/dash?a=1#top", cloud, {
      replaceTabId: launcher,
    });
    expect(mocks.call).not.toHaveBeenCalled();
    expect(workspaceLayoutActions.getLayout("ws-1").workspaceTabs).toEqual([
      expect.objectContaining({ kind: "browser", cloud: true }),
    ]);
    expect(mocks.openExternalPending).not.toHaveBeenCalled();
    expect(useCloudPreviewStore.getState().pending).toMatchObject({
      workspaceId: "ws-1",
      port: 5173,
      rest: "/dash?a=1#top",
    });
    await expect(opening).resolves.toBe("cloud-preview");
  });

  it("asks nothing for a localhost address once this window has heard the address", async () => {
    useCloudPreviewStore.setState({ byWorkspace: { "ws-1": TEMPLATE } });
    await openAddressFromChat("ws-1", "http://localhost:5173/", cloud);
    expect(mocks.call).not.toHaveBeenCalled();
    expect(useCloudPreviewStore.getState().pending).toMatchObject({ port: 5173, rest: "/" });
  });

  it("explains a localhost link on mobile before the preview address is known", async () => {
    vi.mocked(isMobileViewport).mockReturnValueOnce(true);
    await expect(openAddressFromChat("ws-1", "http://localhost:5173", cloud)).resolves.toBe("say");
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(CLOUD_LOCALHOST);
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.openExternalPending).not.toHaveBeenCalled();
  });
});

describe("a cloud card's Open in External Browser on a localhost address", () => {
  const external = {
    kind: "system-browser" as const,
    label: "Open in External Browser",
    url: "http://localhost:3000/a",
  };

  it("reserves a tab in the click, then sends it to the preview's address", async () => {
    const tab = reservedTab();
    let answer: (template: string) => void = () => {};
    mocks.call.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const done = runChatAction("ws-1", external, cloud);
    expect(mocks.openExternalPending).toHaveBeenCalledOnce();
    answer(TEMPLATE);
    await done;

    expect(tab.open).toHaveBeenCalledWith("https://3000-sbx.e2b.app/a");
    expect(tab.cancel).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("closes the reserved tab when the computer has no address, and says so", async () => {
    const tab = reservedTab();
    mocks.call.mockResolvedValue(null);

    await runChatAction("ws-1", external, cloud);

    expect(tab.open).not.toHaveBeenCalled();
    expect(tab.cancel).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(CLOUD_LOCALHOST);
  });

  it.each([false, true])(
    "releases the reserved tab and offers a retry while the address is unknown (mobile=%s)",
    async (mobile) => {
      vi.mocked(isMobileViewport).mockReturnValueOnce(mobile);
      const tab = reservedTab();
      mocks.call.mockResolvedValue(undefined);
      await runChatAction("ws-1", external, cloud);
      expect(tab.cancel).toHaveBeenCalledOnce();
      expect(tab.open).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("Try again"));
    }
  );

  it("closes the reserved tab and offers a retry when this host reconnects during the read", async () => {
    ensureCloudPreviewSubscription();
    const [connectionChanged] = mocks.onConnectionChange.mock.lastCall!;
    const tab = reservedTab();
    const reply = Promise.withResolvers<string>();
    mocks.call.mockReturnValue(reply.promise);
    connectionChanged(false);
    const done = runChatAction("ws-1", external, cloud);
    connectionChanged(true);
    reply.resolve(TEMPLATE);
    await done;
    expect(tab.open).not.toHaveBeenCalled();
    expect(tab.cancel).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("isn't known yet"));
  });

  it("closes the reserved tab silently when the host is replaced", async () => {
    const tab = reservedTab();
    const reply = Promise.withResolvers<string>();
    mocks.call.mockReturnValue(reply.promise);
    const done = runChatAction("ws-1", external, cloud);
    mocks.runtimeState.mockReturnValue("disposed");
    reply.resolve(TEMPLATE);
    await done;
    expect(tab.open).not.toHaveBeenCalled();
    expect(tab.cancel).toHaveBeenCalledOnce();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("uses the address announced while the one-shot read was in flight", async () => {
    const tab = reservedTab();
    const reply = Promise.withResolvers<null>();
    mocks.call.mockReturnValue(reply.promise);
    const done = runChatAction("ws-1", external, cloud);
    useCloudPreviewStore.setState({ byWorkspace: { "ws-1": TEMPLATE } });
    reply.resolve(null);
    await done;
    expect(tab.open).toHaveBeenCalledWith("https://3000-sbx.e2b.app/a");
    expect(tab.cancel).not.toHaveBeenCalled();
  });
});
