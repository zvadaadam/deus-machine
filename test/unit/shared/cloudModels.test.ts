import { describe, it, expect } from "vitest";
import {
  cloudModelChoiceProblem,
  cloudModelThinkingLevels,
  cloudModelsFor,
  findCloudModel,
  readCloudThinkingLevel,
  readCloudTurnSelection,
  type CloudModelList,
} from "@shared/cloud-models";
import { readThinkingLevel } from "@shared/protocol";

/** The shape GET /models answers, trimmed to what the checks read. */
const LISTS: CloudModelList[] = [
  {
    harness: "claude-code",
    source: "catalog",
    fetchedAt: 1,
    models: [
      {
        id: "opus",
        harness: "claude-code",
        label: "Opus 5.5",
        resolvedId: "claude-opus-5-5",
        thinking: { levels: ["low", "medium", "high", "xhigh", "max"] },
      },
      {
        id: "claude-sonnet-4-6",
        harness: "claude-code",
        label: "Sonnet 4.6",
        thinking: { levels: ["low", "medium", "high", "max"] },
      },
      { id: "haiku", harness: "claude-code", label: "Haiku 4.5", thinking: { levels: [] } },
    ],
  },
  {
    harness: "codex-app-server",
    source: "catalog",
    fetchedAt: 1,
    models: [
      {
        id: "gpt-6.1-sol",
        harness: "codex-app-server",
        label: "GPT-6.1-Sol",
        thinking: { levels: ["low", "medium", "high", "xhigh", "max", "ultra"], default: "low" },
      },
    ],
  },
];

describe("the cloud lane's vocabulary", () => {
  it("reads the platform's levels, which the local engine's vocabulary lacks", () => {
    expect(readCloudThinkingLevel("max")).toBe("max");
    expect(readCloudThinkingLevel("ultra")).toBe("ultra");
    expect(readCloudThinkingLevel("extreme")).toBeUndefined();
    expect(readCloudThinkingLevel(undefined)).toBeUndefined();
    // The engine deus embeds (0.3.19) names `max` and `ultra` too: a local
    // turn reads them as the cloud lane does.
    expect(readThinkingLevel("max")).toBe("max");
  });
});

describe("cloud model lists", () => {
  it("finds a harness's models and one model by id", () => {
    expect(cloudModelsFor(LISTS, "claude-code").map((model) => model.id)).toEqual([
      "opus",
      "claude-sonnet-4-6",
      "haiku",
    ]);
    expect(cloudModelsFor(LISTS, "codex-sdk")).toEqual([]);
    expect(findCloudModel(LISTS, "codex-app-server", "gpt-6.1-sol")?.label).toBe("GPT-6.1-Sol");
    expect(findCloudModel(LISTS, "claude-code", "gpt-6.1-sol")).toBeUndefined();
  });

  it("offers a model's own levels, and off alone for one that lists none", () => {
    expect(cloudModelThinkingLevels(findCloudModel(LISTS, "claude-code", "opus")!)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(cloudModelThinkingLevels(findCloudModel(LISTS, "claude-code", "haiku")!)).toEqual([
      "off",
    ]);
  });
});

describe("cloudModelChoiceProblem", () => {
  const choice = (model: string, thinkingLevel: "off" | "high" | "xhigh" | "max", listed = true) =>
    cloudModelChoiceProblem(LISTS, {
      harness: "claude-code",
      model,
      thinkingLevel,
      requireListed: listed,
    });

  it("accepts a listed model at one of its levels", () => {
    expect(choice("opus", "max")).toBeUndefined();
    expect(choice("haiku", "off")).toBeUndefined();
  });

  it("refuses a level the model lacks rather than let the platform run its nearest", () => {
    expect(choice("claude-sonnet-4-6", "xhigh")).toBe(
      "Sonnet 4.6 runs thinking low, medium, high, max — choose one of those."
    );
    expect(choice("haiku", "high")).toMatch(/Haiku 4\.5 runs thinking off/);
  });

  it("refuses an unlisted model chosen now, naming the listed ones", () => {
    expect(choice("claude-opus-5[1m]", "high")).toBe(
      'Deus Cloud doesn\'t run "claude-opus-5[1m]". Choose one of: opus, claude-sonnet-4-6, haiku.'
    );
  });

  it("leaves a saved unlisted model, and a harness listed with nothing, to the platform", () => {
    expect(choice("claude-opus-4-1", "high", false)).toBeUndefined();
    expect(
      cloudModelChoiceProblem([], {
        harness: "claude-code",
        model: "anything",
        thinkingLevel: "high",
        requireListed: true,
      })
    ).toBeUndefined();
  });
});

describe("readCloudTurnSelection", () => {
  it("passes a complete selection through as the platform will read it", () => {
    expect(
      readCloudTurnSelection({
        harness: "codex-app-server",
        model: "gpt-6.1-sol",
        thinkingLevel: "ultra",
      })
    ).toEqual({
      ok: true,
      selection: { harness: "codex-app-server", model: "gpt-6.1-sol", thinkingLevel: "ultra" },
    });
  });

  it.each([
    [{ harness: "claude-code", model: "opus", thinkingLevel: undefined }, /thinking level/],
    [{ harness: "claude-code", model: "", thinkingLevel: "high" }, /model/],
    [{ harness: "claude-code", model: "default", thinkingLevel: "high" }, /model/],
    [{ harness: "acp", model: "opus", thinkingLevel: "high" }, /cloud workspaces/],
  ])("refuses what AGNT refuses: %j", (input, message) => {
    const read = readCloudTurnSelection(input);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toMatch(message);
  });
});
