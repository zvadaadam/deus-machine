import { describe, expect, it } from "vitest";
import { formatTurnDurationLabel } from "@/features/session/ui/utils/formatTurnDurationLabel";

describe("formatTurnDurationLabel", () => {
  it("formats short durations in seconds", () => {
    expect(formatTurnDurationLabel(54_000)).toBe("54s");
  });

  it("formats minute durations as labeled metadata", () => {
    expect(formatTurnDurationLabel(114_000)).toBe("1m 54s");
    expect(formatTurnDurationLabel(210_000)).toBe("3m 30s");
  });

  it("keeps long durations compact by showing the two largest units", () => {
    expect(formatTurnDurationLabel(3_600_000)).toBe("1h");
    expect(formatTurnDurationLabel(3_665_000)).toBe("1h 1m");
  });
});
