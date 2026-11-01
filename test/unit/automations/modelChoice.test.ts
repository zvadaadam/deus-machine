import { describe, it, expect } from "vitest";
import { automationModelChoice, thinkingLevelsFor } from "@/features/automations/lib/model-choice";
import type { CloudModelCatalog } from "@shared/cloud-models";

/** What Deus Cloud lists: runs use Claude Code, so only its list is offered. */
const CATALOG: CloudModelCatalog = {
  configured: true,
  lists: [
    {
      harness: "claude-code",
      source: "catalog",
      fetchedAt: 1,
      models: [
        {
          id: "opus",
          harness: "claude-code",
          label: "Opus 5.5",
          thinking: { levels: ["low", "medium", "high", "xhigh", "max"] },
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
          thinking: { levels: ["low", "ultra"] },
        },
      ],
    },
  ],
};

const choose = (over: Partial<Parameters<typeof automationModelChoice>[0]> = {}) =>
  automationModelChoice({
    catalog: CATALOG,
    savedModel: "",
    model: "",
    thinkingLevel: "",
    ...over,
  });

describe("automation editor model choice", () => {
  it("offers Claude Code's list as the platform orders it, and nothing before a choice", () => {
    const choice = choose();
    expect(choice.models.map((model) => model.id)).toEqual(["opus", "haiku"]);
    expect(choice.levelOptions).toEqual([]);
    expect(choice.savedModel).toBeNull();
  });

  it("offers the chosen model's own levels, and off alone for one without any", () => {
    expect(choose({ model: "opus" }).levelOptions).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(choose({ model: "haiku" }).levelOptions).toEqual(["off"]);
  });

  it("keeps a saved model the list no longer names, marked as such, with every level", () => {
    const choice = choose({ savedModel: "claude-opus-4-1", model: "claude-opus-4-1" });
    expect(choice.savedModel).toBe("claude-opus-4-1");
    expect(choice.savedModelUnlisted).toBe(true);
    expect(choice.levelOptions).toContain("max");
  });

  it("does not call a saved model unlisted before the list has loaded", () => {
    const choice = choose({
      catalog: undefined,
      savedModel: "opus",
      model: "opus",
      thinkingLevel: "high",
    });
    expect(choice.savedModel).toBe("opus");
    expect(choice.savedModelUnlisted).toBe(false);
    // Nothing to offer yet but what the automation already names.
    expect(choice.levelOptions).toEqual(["high"]);
  });

  it("keeps a saved level the chosen model does not list visible instead of dropping it", () => {
    expect(choose({ model: "haiku", thinkingLevel: "high" }).levelOptions).toEqual(["off", "high"]);
  });

  it("tells a model switch which levels the new model has, so a missing one is cleared", () => {
    const { models } = choose();
    expect(thinkingLevelsFor(models, "opus", true)).toContain("xhigh");
    expect(thinkingLevelsFor(models, "haiku", true)).not.toContain("xhigh");
  });
});
