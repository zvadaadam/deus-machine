import { describe, expect, it } from "vitest";
import { extractChatResources } from "@/features/session/lib/chatResources";
import { offeredActions, openingOf } from "@/features/session/lib/openFromChat";
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
