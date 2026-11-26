import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionErrorCard } from "@/features/session/ui/SessionErrorCard";
import { isGenericTurnFailure, readSendRefusal } from "@shared/lib/send-refusal";
import type { QueuedMessages } from "@shared/api/sessions";

const queued = vi.hoisted(() => vi.fn());
vi.mock("@/features/session/api/session.queries", () => ({ useQueuedMessages: queued }));

const REFUSED =
  "PROVIDER_ACCOUNT_RECONNECT_REQUIRED: Your default Claude account must be reconnected in Settings → AI Providers, or choose another default.";

const render = (code: unknown, message: unknown) => {
  const refusal = readSendRefusal(code, message);
  return renderToStaticMarkup(
    createElement(SessionErrorCard, {
      sessionId: "chat",
      message: refusal.message,
      category: refusal.category,
      agentHarness: "claude-code",
      onNewChat: vi.fn(),
    })
  );
};

it("recognizes the platform's generic turn failure wrapper", () => {
  expect(isGenericTurnFailure("AGENT_EXECUTION_FAILED")).toBe(true);
  expect(isGenericTurnFailure("internal")).toBe(false);
  expect(isGenericTurnFailure(undefined)).toBe(false);
});

describe("a send the cloud refused", () => {
  it("reads the platform's sentence, never its codes", () => {
    expect(readSendRefusal("MESSAGE_SEND_FAILED", REFUSED)).toEqual({
      code: "PROVIDER_ACCOUNT_RECONNECT_REQUIRED",
      message:
        "Your default Claude account must be reconnected in Settings → AI Providers, or choose another default.",
      category: "_provider_account",
    });
    expect(readSendRefusal("MESSAGE_SEND_FAILED", "NO_MODEL_ACCOUNT: Choose one.").category).toBe(
      "_provider_account"
    );
    expect(readSendRefusal("WORKSPACE_NOT_READY", "Still starting")).toEqual({
      code: "WORKSPACE_NOT_READY",
      message: "Still starting",
      category: "internal",
    });
  });

  it("offers AI Providers for an account refusal, and no retry", () => {
    const html = render("MESSAGE_SEND_FAILED", REFUSED);
    expect(html).toContain("AI account needed");
    expect(html).toContain("Your default Claude account must be reconnected");
    expect(html).not.toContain("PROVIDER_ACCOUNT_RECONNECT_REQUIRED");
    expect(html).not.toContain("MESSAGE_SEND_FAILED");
    expect(html).toContain("Open AI Providers");
    expect(html).not.toContain("New chat");
  });

  it("shows the full reason for an unrecognized refusal", () => {
    const html = render(
      "MESSAGE_SEND_FAILED",
      "TURN_ID_IN_USE: This turn was admitted concurrently; retry with a new turn ID."
    );
    expect(html).toContain("This turn was admitted concurrently; retry with a new turn ID.");
    expect(html).not.toContain("New chat");
    expect(html).not.toContain("Open AI Providers");
  });

  it("lets the action wrap under the sentence instead of squeezing it into a column", () => {
    const html = render("MESSAGE_SEND_FAILED", REFUSED);
    expect(html).toContain("flex-wrap");
    expect(html).toMatch(/min-w-\[min\(100%,16rem\)\]/);
  });
});

it.each(["process_exit", "rate_limit"])("keeps a %s error in the current chat", (category) => {
  const html = renderToStaticMarkup(
    createElement(SessionErrorCard, {
      sessionId: "chat",
      message: "The agent stopped",
      category,
      onNewChat: vi.fn(),
    })
  );
  expect(html).toContain("The agent stopped");
  expect(html).not.toMatch(/new chat|<button/i);
});

it("offers New chat for a context limit when the chat can open a tab", () => {
  for (const onNewChat of [undefined, vi.fn()]) {
    const html = renderToStaticMarkup(
      createElement(SessionErrorCard, {
        sessionId: "chat",
        message: "This conversation is full",
        category: "context_limit",
        onNewChat,
      })
    );
    expect(html.includes("New chat")).toBe(!!onNewChat);
  }
});

describe("a usage limit", () => {
  const providerMessage = "Your plan limit resets at 5:20am.";
  beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 10, 24, 5, 9) }));
  afterEach(() => vi.useRealTimers());

  function card(limit?: QueuedMessages["limit"], cloud = false) {
    queued.mockReset().mockReturnValue({ data: { limit } });
    return renderToStaticMarkup(
      createElement(SessionErrorCard, {
        sessionId: "limited-chat",
        category: "usage_limit",
        message: providerMessage,
        cloud,
        onNewChat: vi.fn(),
      })
    );
  }

  it("shows the reported reset and offers the following minute in local time", () => {
    const reset = new Date();
    reset.setHours(5, 10, 0, 0);
    const html = card({ resetsAt: reset.getTime(), continues: false });
    expect(queued).toHaveBeenCalledWith("limited-chat");
    expect(html).toContain("Usage limit reached");
    expect(html).toContain("Resets at 05:10.");
    expect(html).toContain("Continue at 05:11");
    expect(html).not.toContain("New chat");
    expect(html).not.toContain(providerMessage);
  });

  it("dates a continuation that crosses midnight and lets the person cancel it", () => {
    const reset = new Date();
    reset.setHours(23, 59, 0, 0);
    const html = card({ resetsAt: reset.getTime(), continues: true });
    const tomorrow = new Date(reset.getTime() + 60_000);
    expect(html).toContain("Resets at 23:59.");
    expect(html).toContain(
      tomorrow.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    );
    expect(html).toMatch(/Continues at [^<]+00:00 while Deus stays open\./);
    expect(html).toContain(">Cancel<");
    expect(html).not.toContain("Continue at ");
    expect(html).not.toContain(providerMessage);
  });

  it("offers Continue after the reset when no continuation is scheduled", () => {
    const reset = new Date(2026, 10, 24, 5, 10).getTime();
    vi.setSystemTime(reset + 1);
    const html = card({ resetsAt: reset, continues: false });
    expect(html).toContain("Reset at 05:10.");
    expect(html).toContain(">Continue<");
    expect(html).not.toMatch(/Resets at|Continue at|>Cancel</);
  });

  it("keeps Cancel available during the minute between reset and automatic continuation", () => {
    const reset = new Date(2026, 10, 24, 5, 10).getTime();
    vi.setSystemTime(reset + 30_000);
    const html = card({ resetsAt: reset, continues: true });
    expect(html).toContain("Reset at 05:10.");
    expect(html).toContain("Continues at 05:11 while Deus stays open.");
    expect(html).toContain(">Cancel<");
    expect(html).not.toContain(">Continue<");
  });

  it("keeps the provider's message after a host restart clears the hold", () => {
    const html = card();
    expect(html).toContain(providerMessage);
    expect(html).not.toMatch(/Resets at|while Deus stays open|<button/);
  });

  it("offers Try again for an untimed local hold and keeps the diagnostic in Details", () => {
    const html = card({ continues: false });
    expect(html).toContain("The provider is rate limiting this chat.");
    expect(html).toContain(">Try again<");
    expect(html.slice(0, html.indexOf("<details"))).not.toContain(providerMessage);
    expect(html.slice(html.indexOf(">Details</summary>"), html.indexOf("</details>"))).toContain(
      providerMessage
    );
  });

  it("keeps the cloud provider's message without reading the local queue or offering a write", () => {
    const html = card({ resetsAt: Date.now(), continues: true }, true);
    expect(html).toContain("Usage limit reached");
    expect(html).toContain(providerMessage);
    expect(queued).not.toHaveBeenCalled();
    expect(html).not.toMatch(/Resets at|<button/);
  });
});
