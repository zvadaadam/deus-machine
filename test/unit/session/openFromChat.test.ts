import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { native } from "@/platform/native";
import { call } from "@/platform/ws";
import { resolveBackendEndpoints } from "@/shared/config/backend.config";
import { toast } from "sonner";
import { extractChatResources } from "@/features/session/lib/chatResources";
import { offeredActions, openFromChat, openingOf } from "@/features/session/lib/openFromChat";
import type { Part } from "@shared/protocol-types";
import type { ChatPlace } from "@/features/workspace/lib/reach";

const local: ChatPlace = { cloud: false, folder: "/r/.deus/a" };
const cloud: ChatPlace = { cloud: true, folder: null };

function cardsFor(text: string) {
  const parts = [{ type: "text", text }] as unknown as Part[];
  return extractChatResources({ parts, isComplete: true, workspacePath: null });
}

const labels = (place: ChatPlace, text: string) =>
  cardsFor(text).map((card) => offeredActions(card, place).map((a) => a.label));

describe("a resource card's actions, by where the chat is", () => {
  it("offers Open and Reveal in Finder only with a folder on this computer", () => {
    expect(labels(local, "See [the deck](out/deck.pptx).")).toEqual([["Open", "Reveal in Finder"]]);
    // In the cloud a deck has nothing this computer can open: no button at all.
    expect(labels(cloud, "See [the deck](out/deck.pptx).")).toEqual([[]]);
  });

  it("keeps the Files tab for an edited page in the cloud, once", () => {
    const edit = {
      type: "tool",
      kind: "edit",
      locations: [{ path: "site/index.html" }],
      state: { status: "running" },
    };
    const [card] = extractChatResources({
      parts: [edit] as unknown as Part[],
      isComplete: true,
      workspacePath: null,
    });
    const offered = (place: ChatPlace) => offeredActions(card, place).map((a) => a.label);
    expect(offered(local)).toEqual(["Open", "Open source", "Reveal in Finder"]);
    // "Open" is the Files tab in the cloud; "Open source" would be the same thing.
    expect(offered(cloud)).toEqual(["Open"]);
    expect(openingOf(card.primaryAction, cloud)).toEqual({
      to: "files",
      path: "site/index.html",
      target: "files",
    });
  });

  it("keeps a cloud pdf's Open, which says why it cannot show here", () => {
    const [card] = cardsFor("The [report](out/report.pdf) is ready.");
    expect(offeredActions(card, cloud).map((a) => a.label)).toEqual(["Open"]);
    expect(openingOf(card.primaryAction, cloud).to).toBe("say");
  });

  it("sends a localhost card in a cloud chat to the cloud computer, never this one", () => {
    const [card] = cardsFor("Running at http://localhost:5173/");
    const place = { ...cloud, previewTemplate: "https://{{port}}-sbx.e2b.app", previewTab: true };
    expect(openingOf(card.primaryAction, place)).toEqual({
      to: "cloud-preview",
      port: 5173,
      rest: "/",
    });
    expect(openingOf(card.secondaryActions[0], place)).toEqual({
      to: "external",
      url: "https://5173-sbx.e2b.app/",
    });
    expect(openingOf(card.primaryAction, local)).toEqual({
      to: "browser-tab",
      url: "http://localhost:5173/",
    });
  });
});

vi.mock("@/platform/ws", async (original) => ({
  ...(await original<typeof import("@/platform/ws")>()),
  call: vi.fn(),
}));
vi.mock("@/shared/config/backend.config", async (original) => ({
  ...(await original<typeof import("@/shared/config/backend.config")>()),
  resolveBackendEndpoints: vi.fn(),
}));

describe("opening a chat file preview in the web browser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([
    [
      "a direct LAN path",
      "/api/workspaces/w/file-preview?path=a%20b.png",
      "http://studio.local:8080/api/workspaces/w/file-preview?path=a%20b.png",
    ],
    [
      "an absolute relay URL",
      "https://relay.example/files/opaque",
      "https://relay.example/files/opaque",
    ],
  ])(
    "opens %s from the Mac in the tab reserved during the click",
    async (_name, returned, expected) => {
      const tab = { open: vi.fn(), cancel: vi.fn() };
      const reserve = vi.spyOn(native.window, "openExternalPending").mockReturnValue(tab);
      vi.mocked(resolveBackendEndpoints).mockResolvedValue({
        apiBase: "http://studio.local:8080/api",
        wsUrl: "ws://studio.local:8080/ws",
      });
      vi.mocked(call).mockResolvedValue({ url: returned });

      const opening = openFromChat("w", { to: "file-preview", path: "a b.png" });
      expect(reserve).toHaveBeenCalledTimes(1);
      await opening;
      expect(call).toHaveBeenCalledWith(api.fileUrl, {
        kind: "preview",
        workspaceId: "w",
        path: "a b.png",
      });
      expect(tab.open).toHaveBeenCalledWith(expected);
      expect(tab.cancel).not.toHaveBeenCalled();
    }
  );

  it("closes the reserved tab and shows the Mac's refusal", async () => {
    const tab = { open: vi.fn(), cancel: vi.fn() };
    vi.spyOn(native.window, "openExternalPending").mockReturnValue(tab);
    const notify = vi.spyOn(toast, "error").mockReturnValue(1);
    vi.mocked(call).mockRejectedValue(new Error("HTML previews are unavailable over the relay"));
    await openFromChat("w", { to: "file-preview", path: "index.html" });
    expect(tab.cancel).toHaveBeenCalledOnce();
    expect(tab.open).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("HTML previews are unavailable over the relay");
  });
});
