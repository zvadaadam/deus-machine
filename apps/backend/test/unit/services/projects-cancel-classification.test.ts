/** Installed-engine qualification, including the temporary Bun patch. No model process is started. */
import { describe, expect, it } from "vitest";
import { ClaudeCodeTransformer } from "@zvada/agent-server/core";

function finish(subtype: string, stopReason: string | null, interrupted: boolean) {
  const transformer = new ClaudeCodeTransformer({ sessionId: "cancel-classification" });
  transformer.process({
    type: "result",
    subtype,
    stop_reason: stopReason,
    is_error: subtype !== "success",
  });
  if (interrupted) transformer.process({ type: "turn_interrupted" });
  return transformer.finish();
}

describe("installed Claude cancellation classification", () => {
  it("classifies an explicitly interrupted tool_use execution failure as cancelled", () => {
    // Exact subtype/finishReason observed during the live Project Pause exercise.
    const result = finish("error_during_execution", "tool_use", true);
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("keeps the same result as a genuine failure without the engine's interruption marker", () => {
    const result = finish("error_during_execution", "tool_use", false);
    expect(result.cancelled).toBe(false);
    expect(result.error).toContain("error_during_execution");
  });

  it("distinguishes the existing ambiguous null-stop failure using the interruption marker", () => {
    expect(finish("error_during_execution", null, true)).toMatchObject({ cancelled: true });
    expect(finish("error_during_execution", null, false)).toMatchObject({
      cancelled: false,
      error: expect.stringContaining("error_during_execution"),
    });
  });

  it("does not blanket-reclassify a distinct terminal failure after an interruption", () => {
    expect(finish("error_max_structured_output_retries", "tool_use", true)).toMatchObject({
      cancelled: false,
      error: expect.stringContaining("error_max_structured_output_retries"),
    });
    expect(finish("success", "end_turn", true)).toMatchObject({ cancelled: false });
  });
});
