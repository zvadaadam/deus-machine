import { describe, it, expect } from "vitest";
import { getThinkingForSession } from "@/shared/agents";
import {
  CATALOG_MODEL_LISTS,
  DEFAULT_MODEL,
  modelForSession,
  modelValue,
  type ModelDescriptor,
} from "@shared/models";
import type { SessionTurn } from "@shared/types/session";

describe("the model a chat continues on", () => {
  const turn = (startedAt: number, model: string): SessionTurn => ({
    turnId: String(startedAt),
    startedAt,
    execution: { harness: "codex-app-server", model },
  });

  it("uses the latest recorded model even when unlisted or history arrives out of order", () => {
    expect(modelForSession("codex-app-server", [turn(2, "old-model"), turn(1, "other")], [])).toBe(
      "old-model"
    );
  });

  it("takes its own harness default when all recorded choices belong to another", () => {
    const model = modelForSession("claude-code", [turn(1, "other")], CATALOG_MODEL_LISTS);
    expect(modelValue("claude-code", model!)).toBe(DEFAULT_MODEL);
  });

  it("takes the marked account model when a harness has no catalog rows", () => {
    const harness = "scripted";
    const models: ModelDescriptor[] = ["small", "large"].map((id) => ({
      harness,
      id,
      label: id,
      isDefault: id === "large",
      thinking: { levels: ["low", "high"] },
    }));
    expect(modelForSession(harness, [], CATALOG_MODEL_LISTS)).toBeUndefined();
    const lists = [{ harness, source: "live" as const, models }];
    expect(modelForSession(harness, [], lists)).toBe("large");
    expect(
      modelForSession(harness, [{ turnId: "1", execution: { harness, model: "retired" } }], lists)
    ).toBe("retired");
  });
});

describe("reopened conversation thinking level", () => {
  const turn = (startedAt: number, thinkingLevel?: string, appliedThinkingLevel?: string) =>
    ({
      turnId: String(startedAt),
      startedAt,
      execution: {
        harness: "codex-app-server",
        model: "gpt-6.1-sol",
        thinkingLevel,
        appliedThinkingLevel,
      },
    }) as SessionTurn;

  it("is the level the latest turn ran, else the user's default", () => {
    expect(
      getThinkingForSession("codex-app-server", [turn(2, "low"), turn(1, "max")], "high")
    ).toBe("low");
    expect(getThinkingForSession("codex-app-server", [turn(1)], "high")).toBe("high");
    // The level asked for is what the composer showed; one sent without a level ran at the applied one.
    expect(getThinkingForSession("codex-app-server", [turn(1, "ultra", "max")], "high")).toBe(
      "ultra"
    );
    expect(getThinkingForSession("codex-app-server", [turn(1, undefined, "low")], "high")).toBe(
      "low"
    );
    expect(getThinkingForSession("codex-app-server", [], "medium")).toBe("medium");
  });
});
