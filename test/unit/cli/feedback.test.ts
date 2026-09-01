import { describe, it, expect } from "vitest";
import { buildFeedbackPayload, safe } from "../../../apps/cli/src/feedback";

describe("buildFeedbackPayload (deus feedback → Hivenet wire shape)", () => {
  it("builds the keyless v1 payload with cli defaults", () => {
    const p = buildFeedbackPayload("feature request: pin a workspace", "0.3.8", {
      threadId: "abc123",
    });
    expect(p).toEqual({
      v: 1,
      to: "deus",
      category: "cli",
      feedback: "feature request: pin a workspace",
      thread: { id: "abc123" },
      client: { name: "deus-cli", version: "0.3.8" },
      consent: { telemetry: false },
    });
  });

  it("carries subject + category overrides, omits subject when absent", () => {
    const p = buildFeedbackPayload("msg", "1.0.0", {
      subject: "deus pair",
      category: "ux",
      threadId: "t",
    });
    expect(p.subject).toBe("deus pair");
    expect(p.category).toBe("ux");
    expect("subject" in buildFeedbackPayload("msg", "1.0.0", { threadId: "t" })).toBe(false);
  });

  it("mints a 32-char hex-ish thread id when none is given", () => {
    const p = buildFeedbackPayload("msg", "1.0.0");
    expect(p.thread.id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("safe (terminal output wash for response-derived text)", () => {
  it("strips ANSI/OSC escapes and C0/C1 controls, keeps ordinary text", () => {
    expect(safe("\u001b[31mred\u001b[0m alert")).toBe("[31mred [0m alert");
    expect(safe("\u009d\u0007ding")).toBe("ding");
    expect(safe("plain guidance text.")).toBe("plain guidance text.");
  });

  it("flattens newlines — response fields print as single lines", () => {
    expect(safe("line one\r\nline two")).toBe("line one  line two");
  });

  it("returns empty for non-string shapes (unvalidated response cast)", () => {
    expect(safe(42)).toBe("");
    expect(safe(null)).toBe("");
    expect(safe(undefined)).toBe("");
    expect(safe({ nested: true })).toBe("");
  });
});
