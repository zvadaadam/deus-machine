import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionErrorCard } from "@/features/session/ui/SessionErrorCard";
import { readSendRefusal } from "@shared/lib/send-refusal";

const REFUSED =
  "PROVIDER_ACCOUNT_RECONNECT_REQUIRED: Your default Claude account must be reconnected in Settings → AI Providers, or choose another default.";

const render = (code: unknown, message: unknown) => {
  const refusal = readSendRefusal(code, message);
  return renderToStaticMarkup(
    createElement(SessionErrorCard, {
      message: refusal.message,
      category: refusal.category,
      agentHarness: "claude-code",
      onRetryInNewChat: vi.fn(),
    })
  );
};

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
    expect(html).not.toContain("Retry in new chat");
  });

  it("keeps the retry for a refusal with no way out, its sentence whole", () => {
    const html = render(
      "MESSAGE_SEND_FAILED",
      "TURN_ID_IN_USE: This turn was admitted concurrently; retry with a new turn ID."
    );
    expect(html).toContain("This turn was admitted concurrently; retry with a new turn ID.");
    expect(html).toContain("Retry in new chat");
    expect(html).not.toContain("Open AI Providers");
  });

  it("lets the action wrap under the sentence instead of squeezing it into a column", () => {
    const html = render("MESSAGE_SEND_FAILED", REFUSED);
    expect(html).toContain("flex-wrap");
    expect(html).toMatch(/min-w-\[min\(100%,16rem\)\]/);
  });
});
