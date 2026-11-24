import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
      onRetryInNewChat: vi.fn(),
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

  it("keeps the retry for a refusal with no way out, its sentence whole", () => {
    const html = render(
      "MESSAGE_SEND_FAILED",
      "TURN_ID_IN_USE: This turn was admitted concurrently; retry with a new turn ID."
    );
    expect(html).toContain("This turn was admitted concurrently; retry with a new turn ID.");
    expect(html).toContain("New chat");
    expect(html).not.toContain("Open AI Providers");
  });

  it("lets the action wrap under the sentence instead of squeezing it into a column", () => {
    const html = render("MESSAGE_SEND_FAILED", REFUSED);
    expect(html).toContain("flex-wrap");
    expect(html).toMatch(/min-w-\[min\(100%,16rem\)\]/);
  });
});

it("only offers starting a chat when the action is available", () => {
  for (const onRetryInNewChat of [undefined, vi.fn()]) {
    const html = renderToStaticMarkup(
      createElement(SessionErrorCard, {
        sessionId: "chat",
        message: "Usage limit reached",
        category: "rate_limit",
        onRetryInNewChat,
      })
    );
    expect(html.includes("Start a new chat")).toBe(!!onRetryInNewChat);
    expect(html.includes("New chat")).toBe(!!onRetryInNewChat);
  }
});

describe("a usage limit", () => {
  const providerMessage = "Your plan limit resets at 5:20am.";

  function card(limit?: QueuedMessages["limit"], cloud = false) {
    queued.mockReset().mockReturnValue({ data: { limit } });
    return renderToStaticMarkup(
      createElement(SessionErrorCard, {
        sessionId: "limited-chat",
        category: "usage_limit",
        message: providerMessage,
        cloud,
        onRetryInNewChat: vi.fn(),
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

  it("keeps the provider's message when the reset is unknown or the host restarted", () => {
    for (const limit of [undefined, { continues: false }]) {
      const html = card(limit);
      expect(html).toContain("Usage limit reached");
      expect(html).toContain(providerMessage);
      expect(html).not.toMatch(/Resets at|while Deus stays open|<button/);
    }
  });

  it("keeps the cloud provider's message without reading the local queue or offering a write", () => {
    const html = card({ resetsAt: Date.now(), continues: true }, true);
    expect(html).toContain("Usage limit reached");
    expect(html).toContain(providerMessage);
    expect(queued).not.toHaveBeenCalled();
    expect(html).not.toMatch(/Resets at|<button/);
  });
});
