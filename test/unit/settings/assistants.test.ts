import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Assistant } from "@shared/types/assistants";

const list = vi.hoisted(() => ({
  data: undefined as Assistant[] | undefined,
  isError: false,
}));
vi.mock("@/features/settings/api/assistants.queries", () => ({
  useAssistants: () => ({ ...list, isSuccess: list.data !== undefined }),
  useSetAssistantAccess: () => ({ mutateAsync: vi.fn() }),
  useRemoveAssistant: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import {
  accessLabel,
  addAssistantState,
  arrivalDescription,
  assistantOrigin,
  createArrivalTracker,
  requestKey,
  shortenMiddle,
  sortAssistants,
  waitingCount,
} from "@/features/settings/lib/assistants";
import { AssistantsSection } from "@/features/settings/ui/sections/AssistantsSection";

const assistant = (clientId: string, fields: Partial<Assistant> = {}): Assistant => ({
  clientId,
  name: clientId,
  host: null,
  access: "read",
  createdAt: 0,
  lastSeenAt: 0,
  ...fields,
});

beforeEach(() => {
  list.data = undefined;
  list.isError = false;
});

describe("sortAssistants", () => {
  it("puts waiting first (newest request on top), then allowed by latest use, then denied", () => {
    const sorted = sortAssistants([
      assistant("recent-denied", { access: "denied", lastSeenAt: 99 }),
      assistant("old-read", { lastSeenAt: 10 }),
      assistant("first-wait", { access: "pending", createdAt: 5 }),
      assistant("old-denied", { access: "denied", lastSeenAt: 1 }),
      assistant("recent-operate", { access: "operate", lastSeenAt: 50 }),
      assistant("second-wait", { access: "pending", createdAt: 7 }),
    ]);
    expect(sorted.map((a) => a.clientId)).toEqual([
      "second-wait",
      "first-wait",
      "recent-operate",
      "old-read",
      "recent-denied",
      "old-denied",
    ]);
  });

  it("leaves the list it was given alone", () => {
    const given = [assistant("a", { lastSeenAt: 1 }), assistant("b", { lastSeenAt: 2 })];
    sortAssistants(given);
    expect(given.map((a) => a.clientId)).toEqual(["a", "b"]);
  });
});

describe("createArrivalTracker", () => {
  it("announces nothing for assistants already waiting when the app opened", () => {
    const track = createArrivalTracker();
    expect(track([assistant("waiting", { access: "pending" })])).toEqual([]);
    expect(track([assistant("waiting", { access: "pending" })])).toEqual([]);
  });

  it("announces each request once, keyed by the assistant and its first contact", () => {
    const track = createArrivalTracker();
    expect(track([])).toEqual([]);
    const chatgpt = assistant("chatgpt", { access: "pending", createdAt: 100 });
    expect(track([chatgpt])).toEqual([chatgpt]);
    expect(track([{ ...chatgpt, lastSeenAt: 200 }])).toEqual([]);
    // Removed, then asking again: a new first contact, so a new request.
    expect(track([])).toEqual([]);
    const again = { ...chatgpt, createdAt: 300 };
    expect(track([again])).toEqual([again]);
    expect(track([again])).toEqual([]);
  });

  it("never announces a denied assistant", () => {
    const track = createArrivalTracker();
    track([]);
    expect(track([assistant("impostor", { access: "denied", createdAt: 5 })])).toEqual([]);
  });

  it("keys a request by client id and first contact", () => {
    expect(requestKey(assistant("chatgpt", { createdAt: 42 }))).toBe("chatgpt:42");
  });

  it("does not announce allowed assistants, and announces each new waiting one", () => {
    const track = createArrivalTracker();
    track([assistant("claude", { access: "operate" })]);
    const grok = assistant("grok", { access: "pending" });
    const dots = assistant("dots", { access: "pending" });
    expect(track([assistant("claude", { access: "operate" }), grok])).toEqual([grok]);
    expect(track([grok, dots])).toEqual([dots]);
  });
});

describe("where an assistant signs in", () => {
  it("names the host when it is known", () => {
    expect(assistantOrigin({ clientId: "abc", host: "chatgpt.com" })).toEqual({
      host: "chatgpt.com",
      lead: "Signs in through",
    });
  });

  it("falls back to the client id, shortened in the middle when long", () => {
    expect(assistantOrigin({ clientId: "client-7f3a", host: null })).toEqual({
      clientId: "client-7f3a",
      lead: "Unverified",
    });
    const long = "dcr_0123456789abcdefghijklmnopqrstuvwxyz";
    const short = shortenMiddle(long);
    expect(short).toHaveLength(20);
    expect(short).toBe("dcr_012345…rstuvwxyz");
    expect(assistantOrigin({ clientId: long, host: null })).toEqual({
      clientId: short,
      lead: "Unverified",
    });
  });

  it("is said first in a waiting assistant's toast, in the row's words", () => {
    expect(arrivalDescription({ clientId: "abc", host: "chatgpt.com" })).toBe(
      "Signs in through chatgpt.com. Allow it to see your workspaces and work with your agents."
    );
    expect(
      arrivalDescription({ clientId: "dcr_0123456789abcdefghijklmnopqrstuvwxyz", host: null })
    ).toBe(
      "Unverified dcr_012345…rstuvwxyz. Allow it to see your workspaces and work with your agents."
    );
  });
});

describe("the Add assistant dialog", () => {
  const URL = "https://cloud.deusmachine.ai/mcp/mac-7f3a9c21";

  it("shows the computer's address whenever it has one, even to a signed-out browser", () => {
    expect(addAssistantState({ address: URL, signedOut: false, remoteAccessOn: true })).toBe(
      "address"
    );
    // A browser on this computer or its network has no session of its own.
    expect(addAssistantState({ address: URL, signedOut: true, remoteAccessOn: true })).toBe(
      "address"
    );
  });

  it("says what is missing only when there is no address", () => {
    expect(addAssistantState({ address: undefined, signedOut: true, remoteAccessOn: true })).toBe(
      "loading"
    );
    expect(addAssistantState({ address: null, signedOut: true, remoteAccessOn: true })).toBe(
      "sign_in"
    );
    expect(addAssistantState({ address: null, signedOut: true, remoteAccessOn: false })).toBe(
      "sign_in"
    );
    expect(addAssistantState({ address: null, signedOut: false, remoteAccessOn: false })).toBe(
      "turn_on"
    );
    expect(addAssistantState({ address: null, signedOut: false, remoteAccessOn: true })).toBe(
      "retry"
    );
  });
});

describe("labels", () => {
  it("names the access levels and counts who waits", () => {
    expect(accessLabel("read")).toBe("Read only");
    expect(accessLabel("operate")).toBe("Operate");
    expect(accessLabel("denied")).toBe("Denied");
    expect(waitingCount(undefined)).toBe(0);
    expect(
      waitingCount([
        assistant("a", { access: "pending" }),
        assistant("b"),
        assistant("c", { access: "denied" }),
      ])
    ).toBe(1);
  });
});

describe("AssistantsSection", () => {
  const render = () =>
    renderToStaticMarkup(
      createElement(AssistantsSection, {
        remoteAccessOn: true,
        onTurnOnRemoteAccess: () => {},
        signIn: () => {},
        signingIn: false,
        signedOut: false,
        address: undefined,
        onRetryAddress: () => {},
      })
    );

  it("shows one quiet line and the Add action when there are none", () => {
    list.data = [];
    const html = render();
    expect(html).toContain("No assistants yet.");
    expect(html).toContain("Add assistant");
  });

  it("shows nothing in the list until the host answers", () => {
    expect(render()).not.toContain("No assistants yet.");
  });

  it("shows a waiting assistant first, with where it signs in, Allow and Deny", () => {
    list.data = [
      assistant("claude", {
        name: "Claude",
        host: "claude.ai",
        access: "operate",
        lastSeenAt: Date.now(),
      }),
      assistant("chatgpt", {
        name: "ChatGPT",
        host: "chatgpt.com",
        access: "pending",
        createdAt: Date.now(),
      }),
    ];
    const html = render();
    expect(html.indexOf("ChatGPT wants to connect")).toBeGreaterThan(-1);
    expect(html.indexOf("ChatGPT wants to connect")).toBeLessThan(html.indexOf(">Claude<"));
    expect(html).toContain("Signs in through chatgpt.com · Asked just now");
    expect(html).toContain("Deny");
    expect(html).toContain('aria-label="Allow ChatGPT"');
    expect(html).toContain('aria-label="Access for Claude: Operate"');
    expect(html).toContain("claude.ai · Last used just now");
  });

  it("marks an assistant with no known host as unverified, by its client id", () => {
    list.data = [assistant("client-7f3a", { name: "ChatGPT", access: "pending" })];
    expect(render()).toContain('Unverified <span class="font-mono">client-7f3a</span> · Asked');
  });

  it("lists a denied assistant last, quietly, with its actions in a menu", () => {
    list.data = [
      assistant("impostor", { name: "Impostor", access: "denied", lastSeenAt: Date.now() }),
      assistant("claude", { name: "Claude", access: "read", lastSeenAt: 0 }),
    ];
    const html = render();
    expect(html.indexOf(">Impostor<")).toBeGreaterThan(html.indexOf(">Claude<"));
    expect(html).toContain(">Denied<");
    expect(html).toContain('aria-label="Actions for Impostor"');
    expect(html).not.toContain('aria-label="Access for Impostor');
  });

  it("says when the list could not be read", () => {
    list.isError = true;
    expect(render()).toContain("Couldn&#x27;t load assistants.");
  });
});
