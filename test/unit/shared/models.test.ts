import { describe, expect, it } from "vitest";
import {
  CATALOG_MODEL_LISTS,
  DEFAULT_MODEL,
  defaultModelId,
  findModel,
  fitThinkingLevel,
  modelLabel,
  modelThinkingLevels,
  parseModelValue,
  pickerModels,
  type HarnessModels,
  type ModelDescriptor,
} from "@shared/models";
import { modelPickerView } from "@/shared/agents/picker";

const row = (
  harness: ModelDescriptor["harness"],
  id: string,
  label: string,
  levels: ModelDescriptor["thinking"]["levels"],
  extra: Partial<ModelDescriptor> = {}
): ModelDescriptor => ({ id, harness, label, thinking: { levels }, ...extra });

// What a login's CLIs might list: fewer Claude models, and a Codex model the catalog lacks.
const lists: HarnessModels[] = [
  {
    harness: "claude-code",
    models: [
      row("claude-code", "default", "Default (recommended)", ["low", "high"], {
        resolvedId: "claude-opus-5-5",
        isDefault: true,
      }),
      row("claude-code", "sonnet", "Sonnet 5.5", ["low", "medium", "high"]),
      row("claude-code", "opus", "Opus 5.5", ["low", "medium", "high", "xhigh", "max"], {
        resolvedId: "claude-opus-5-5",
      }),
      row("claude-code", "haiku", "Haiku 4.5", []),
    ],
  },
  {
    harness: "codex-app-server",
    models: [
      row("codex-app-server", "gpt-next", "GPT-Next", ["low", "high"]),
      row("codex-app-server", "gpt-6.1-sol", "GPT-6.1-Sol", ["low", "medium", "high", "ultra"], {
        isDefault: true,
      }),
    ],
  },
];

describe("the engine's catalog, as Deus reads it", () => {
  it("lists both harnesses and starts a new chat on a model it lists", () => {
    expect(CATALOG_MODEL_LISTS.map((list) => list.harness)).toEqual([
      "claude-code",
      "codex-app-server",
    ]);
    for (const { harness } of CATALOG_MODEL_LISTS) {
      expect(pickerModels(CATALOG_MODEL_LISTS, harness).length).toBeGreaterThan(0);
    }
    const chosen = parseModelValue(DEFAULT_MODEL)!;
    expect(chosen.harness).toBe("claude-code");
    expect(findModel(CATALOG_MODEL_LISTS, chosen.harness, chosen.model)?.row.id).toBe(chosen.model);
  });
});

describe("a harness's rows", () => {
  it("leaves out the account-default alias, which no chat picks", () => {
    expect(pickerModels(lists, "claude-code").map((model) => model.id)).toEqual([
      "sonnet",
      "opus",
      "haiku",
    ]);
  });

  it("answers a legacy harness with its successor's rows", () => {
    expect(pickerModels(lists, "codex-sdk")).toEqual(pickerModels(lists, "codex-app-server"));
  });
});

describe("the model a new chat starts on", () => {
  it("is Deus's preference when the list offers it", () => {
    expect(defaultModelId(CATALOG_MODEL_LISTS, "claude-code")).toBe("opus");
    expect(DEFAULT_MODEL).toBe("claude-code:opus");
    // Also when it is not the list's first row.
    expect(defaultModelId(lists, "claude-code")).toBe("opus");
  });

  it("is otherwise the harness's own default, as a row a chat can pick", () => {
    expect(defaultModelId(lists, "codex-app-server")).toBe("gpt-6.1-sol");
    const noPreference = [{ ...lists[0], models: lists[0].models.filter((m) => m.id !== "opus") }];
    // Claude marks the alias; no selectable row runs that model here, so the first row.
    expect(defaultModelId(noPreference, "claude-code")).toBe("sonnet");
  });

  it("is nothing for a harness with no list", () => {
    expect(defaultModelId([], "claude-code")).toBeUndefined();
  });
});

describe("a model as a chat shows it", () => {
  it("uses the listed label, and names the window a variant asks for", () => {
    expect(modelLabel(lists, "claude-code", "opus")).toBe("Opus 5.5");
    expect(modelLabel(lists, "claude-code", "opus[1m]")).toBe("Opus 5.5 1M");
    expect(modelLabel(lists, "claude-code", "claude-retired-3")).toBe("claude-retired-3");
  });

  it("offers the model's own thinking levels, a variant's being its model's", () => {
    expect(modelThinkingLevels(lists, "claude-code", "sonnet")).toEqual(["low", "medium", "high"]);
    expect(modelThinkingLevels(lists, "claude-code", "opus[1m]")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(modelThinkingLevels(lists, "claude-code", "haiku")).toEqual([]);
  });

  it("offers every level the harness lists for a model no list names", () => {
    expect(modelThinkingLevels(lists, "codex-app-server", "older-model")).toEqual([
      "low",
      "medium",
      "high",
      "ultra",
    ]);
    expect(modelThinkingLevels([], "codex-app-server", "older-model")).toEqual([]);
  });
});

describe("the thinking level after a model change", () => {
  it("keeps a level the model offers and otherwise takes the nearest one below", () => {
    expect(fitThinkingLevel("high", ["low", "medium", "high"], "medium")).toBe("high");
    expect(fitThinkingLevel("max", ["low", "medium", "high"], "medium")).toBe("high");
    expect(fitThinkingLevel("low", ["medium", "high"], "high")).toBe("medium");
  });

  it("is off for a model with no thinking control, and the user's default after one", () => {
    expect(fitThinkingLevel("high", [], "medium")).toBe("off");
    expect(fitThinkingLevel("off", ["low", "medium", "high"], "medium")).toBe("medium");
  });
});

describe("a picker value", () => {
  it("names its harness and model, whatever the model", () => {
    expect(parseModelValue("claude-code:claude-opus-5[1m]")).toEqual({
      harness: "claude-code",
      model: "claude-opus-5[1m]",
    });
    expect(parseModelValue(" codex-app-server:gpt-next ")).toEqual({
      harness: "codex-app-server",
      model: "gpt-next",
    });
  });

  it("reads the harness spellings older builds stored", () => {
    expect(parseModelValue("claude:sonnet")).toEqual({ harness: "claude-code", model: "sonnet" });
    expect(parseModelValue("codex-server:gpt-5.5")).toEqual({
      harness: "codex-app-server",
      model: "gpt-5.5",
    });
    // The retired Codex harnesses named models the engine no longer lists.
    for (const value of ["codex:gpt-5.3-codex", "codex-sdk:gpt-5.2-codex"]) {
      expect(parseModelValue(value)).toEqual({
        harness: "codex-app-server",
        model: defaultModelId(CATALOG_MODEL_LISTS, "codex-app-server"),
      });
    }
  });

  it("is refused when it names no harness Deus runs", () => {
    for (const value of ["", "sonnet", "claude-code:", ":sonnet", "gemini:pro"]) {
      expect(parseModelValue(value)).toBeUndefined();
    }
  });
});

describe("what a model picker shows", () => {
  it("groups each harness's rows under its name and marks the chat's model", () => {
    const view = modelPickerView(lists, "codex-app-server:gpt-6.1-sol");
    expect(view.groups.map((group) => [group.label, group.options.map((o) => o.label)])).toEqual([
      ["Claude Code", ["Sonnet 5.5", "Opus 5.5", "Haiku 4.5"]],
      ["Codex", ["GPT-Next", "GPT-6.1-Sol"]],
    ]);
    expect(view.selected).toEqual({
      value: "codex-app-server:gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      agentHarness: "codex-app-server",
    });
  });

  it("keeps the chat's model among its harness's rows when no list names it", () => {
    const view = modelPickerView(lists, "claude-code:opus[1m]");
    expect(view.selected?.label).toBe("Opus 5.5 1M");
    expect(view.groups[0].options.map((option) => option.value)).toEqual([
      "claude-code:opus[1m]",
      "claude-code:sonnet",
      "claude-code:opus",
      "claude-code:haiku",
    ]);
    expect(view.groups[1].options).toHaveLength(2);
  });

  it("marks nothing for a value that names no harness", () => {
    expect(modelPickerView(lists, "sonnet").selected).toBeUndefined();
  });
});
