import { describe, expect, it } from "vitest";
import {
  CATALOG_MODEL_LISTS,
  DEFAULT_MODEL,
  defaultModelId,
  findModel,
  composerThinking,
  fitThinkingLevel,
  harnessNamed,
  modelLabel,
  modelValue,
  thinkingLevelLabel,
  modelThinkingLevels,
  parseModelValue,
  pickerModels,
  type HarnessModels,
  type ModelDescriptor,
} from "@shared/models";
import { LOCAL_HARNESSES } from "@shared/harnesses";
import type { GatewayCatalog } from "@shared/gateways";
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
    source: "live",
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
    source: "live",
    models: [
      row("codex-app-server", "gpt-next", "GPT-Next", ["low", "high"]),
      row("codex-app-server", "gpt-6.1-sol", "GPT-6.1-Sol", ["low", "medium", "high", "ultra"], {
        isDefault: true,
      }),
    ],
  },
];

describe("the engine's catalog, as Deus reads it", () => {
  it("lists every local harness and starts a new chat on a model it lists", () => {
    expect(CATALOG_MODEL_LISTS.map((list) => list.harness)).toEqual(LOCAL_HARNESSES);
    expect(pickerModels(CATALOG_MODEL_LISTS, "gemini")).toEqual([]);
    for (const harness of ["claude-code", "codex-app-server"] as const) {
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

  it("starts from the user's default when the model has no match for a level only another model lists", () => {
    // A model's own level (`turbo`) leaves for one without it: never `off`.
    expect(fitThinkingLevel("turbo", ["low", "medium", "high"], "high")).toBe("high");
    expect(fitThinkingLevel("turbo", ["low", "medium"], "high")).toBe("medium");
    expect(fitThinkingLevel("turbo", ["turbo", "low"], "high")).toBe("turbo");
    expect(fitThinkingLevel("turbo", ["fast", "deep"], "high")).toBe("fast");
  });
});

describe("a thinking level's label", () => {
  it("is Deus's word for a level it knows, else the level's own name", () => {
    expect(thinkingLevelLabel("xhigh")).toBe("Extra high");
    expect(thinkingLevelLabel("turbo")).toBe("Turbo");
  });

  it("reads an object's own names as levels like any other", () => {
    expect(thinkingLevelLabel("constructor")).toBe("Constructor");
    expect(thinkingLevelLabel("__proto__")).toBe("__proto__");
    expect(thinkingLevelLabel("toString")).toBe("ToString");
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

  it("reads a retired Codex harness as Codex's default", () => {
    // The retired Codex harness named models the engine no longer lists.
    expect(parseModelValue("codex:gpt-5.3-codex")).toEqual({
      harness: "codex-app-server",
      model: defaultModelId(CATALOG_MODEL_LISTS, "codex-app-server"),
    });
  });

  it("is refused when it names no harness Deus runs", () => {
    for (const value of [
      "",
      "sonnet",
      "claude-code:",
      ":sonnet",
      "unknown-agent:pro",
      "claude:sonnet",
    ]) {
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
    expect(view.selected).toMatchObject({
      value: "codex-app-server:gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      agentHarness: "codex-app-server",
    });
  });

  it("shows a Custom model only on formats allowed by its catalog and connection", () => {
    const gateway: GatewayCatalog = {
      ref: "custom",
      preset: "custom",
      formats: ["responses", "messages"],
      generation: "rev",
      address: "http://localhost",
      models: [
        { id: "alias", label: "Alias", provider: "" },
        { id: "responses", label: "Responses only", provider: "", formats: ["responses"] },
        { id: "image", label: "Image", provider: "", excluded: "non_chat" },
        { id: "hidden", label: "Hidden", provider: "", excluded: "hidden" },
      ],
    };
    const options = (formats: GatewayCatalog["formats"]) =>
      modelPickerView([], undefined, "", [{ ...gateway, formats }]).groups.map((g) => [
        g.agentHarness,
        g.options.map((o) => o.id),
      ]);
    expect(options(gateway.formats)).toEqual([
      ["claude-code", ["alias"]],
      ["codex-app-server", ["alias", "responses"]],
    ]);
    expect(options(["messages"])).toEqual([["claude-code", ["alias"]]]);
  });

  it("selects one existing native row for a subscription choice saved by an older client", () => {
    const old = "codex:gpt-5.3-codex";
    const current = defaultModelId(CATALOG_MODEL_LISTS, "codex-app-server")!;
    const view = modelPickerView(CATALOG_MODEL_LISTS, old);
    expect(view.selected?.value).toBe(modelValue("codex-app-server", current));
    expect(
      view.groups
        .find((group) => group.agentHarness === "codex-app-server")
        ?.options.filter((option) => option.id === current)
    ).toHaveLength(1);
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

  it("places each gateway route in its runner's tab and search keeps the available agents", () => {
    const gateway: GatewayCatalog = {
      ref: "fixture-gateway",
      preset: "cliproxyapi",
      formats: ["responses", "messages"],
      generation: "revision",
      address: "http://localhost",
      models: [
        {
          id: "internal:one",
          label: "Friendly",
          provider: "openai",
          runner: "codex-app-server",
          thinking: { levels: ["high"] },
        },
        { id: "claude-a", label: "Sonnet", provider: "anthropic", runner: "claude-code" },
        { id: "other", label: "Kimi K3", provider: "kimi", runner: "claude-code" },
        { id: "unclassified", label: "unclassified", provider: "unknown" },
      ],
    };
    const selected = modelValue("codex-app-server", "internal:one", gateway.generation);
    const view = modelPickerView(lists, selected, "", [gateway]);
    const tabs = view.groups.filter((g) => g.source === gateway.ref);
    expect(
      tabs.map((g) => [g.agentHarness, g.options.map((o) => [o.id, o.heading?.label])])
    ).toEqual([
      [
        "claude-code",
        [
          ["claude-a", "Anthropic"],
          ["other", "Kimi"],
        ],
      ],
      ["codex-app-server", [["internal:one", undefined]]],
    ]);
    expect(
      view.groups
        .filter((g) => g.source === "subscriptions")
        .flatMap((g) => g.options)
        .some((o) => o.gatewayGeneration)
    ).toBe(false);
    for (const query of ["FRIEND", "nal:one", "OpenAI"]) {
      const filtered = modelPickerView(lists, selected, query, [gateway]);
      const tabs = filtered.groups.filter((g) => g.source === gateway.ref);
      expect(tabs.map((g) => g.agentHarness)).toEqual(["claude-code", "codex-app-server"]);
      expect(tabs[0].empty?.message).toBe("No matching models.");
      expect(tabs[1].options.map((o) => o.value)).toEqual([selected]);
      expect(filtered.selected).toMatchObject({
        label: "Friendly",
        thinking: { levels: ["high"] },
      });
    }
    expect(modelPickerView(lists, selected, "", null).selected).toMatchObject({
      value: selected,
      unavailable: true,
    });
    expect(
      modelPickerView(lists, selected, "", [{ ...gateway, models: gateway.models.slice(0, 1) }])
        .groups.filter((g) => g.source === gateway.ref)
        .map((g) => g.label)
    ).toEqual(["Codex"]);
  });

  it("searches even a short subscription list and carries each result’s own thinking controls", () => {
    const view = modelPickerView(lists, "claude-code:opus", "sonnet");
    expect(view.groups[0].options.map((o) => [o.label, o.thinking?.levels])).toEqual([
      ["Sonnet 5.5", ["low", "medium", "high"]],
    ]);
    expect(view.selected?.label).toBe("Opus 5.5");
    expect(modelPickerView(lists, "claude-code:opus", "missing").groups[0].empty?.message).toBe(
      "No matching models."
    );
  });

  it("marks nothing for a value that names no harness", () => {
    expect(modelPickerView(lists, "sonnet").selected).toBeUndefined();
  });
});

describe("the level a chat shows and sends", () => {
  it("keeps a seeded level against the catalog, and fits it only once the live list is in", () => {
    const catalog = ["low", "medium", "high", "xhigh", "max"];
    // Provisional (no live levels): the chat's own level, as seeded.
    expect(composerThinking("ultra", undefined, "high")).toBe("ultra");
    // The live list offers it: still the chat's own.
    expect(composerThinking("ultra", [...catalog, "ultra"], "high")).toBe("ultra");
    // The live list does not: the nearest the model has.
    expect(composerThinking("ultra", catalog, "high")).toBe("max");
  });
});

describe("harnessNamed", () => {
  it("reads an agent by its id or as people say it, in any case, spaces and hyphens aside", () => {
    for (const said of [
      "claude-code",
      "Claude Code",
      "claude",
      "CLAUDE",
      "claude_code",
      " Claude-Code ",
    ])
      expect(harnessNamed(said)).toBe("claude-code");
    for (const said of ["codex-app-server", "Codex", "codex", "codex app server"])
      expect(harnessNamed(said)).toBe("codex-app-server");
    expect(harnessNamed("Gemini")).toBe("gemini");
    for (const said of ["unknown-agent", "", "claude-codex", "acp"])
      expect(harnessNamed(said)).toBeUndefined();
  });
});

it("round-trips the gateway revision and the full model id", () => {
  const value = modelValue("codex-app-server", "vendor/model:variant", "edition");
  expect(value).toBe("gateway:codex-app-server:edition:vendor/model:variant");
  expect(parseModelValue(value)).toEqual({
    harness: "codex-app-server",
    model: "vendor/model:variant",
    gatewayGeneration: "edition",
  });
});
