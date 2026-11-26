import { useGatewayFixture, run, key, baseUrl, prepared, connectHere } from "./setup";
import { expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { gatewaySupports } from "@shared/gateways";
import { GatewayError } from "../../../../src/lib/errors";
import { checkCatalog } from "../../../../src/services/gateways/catalog";

useGatewayFixture();

it.each([
  ["x", "Codex Max", true],
  ["1", "Codex Max", true],
  ["8317", "Codex Max", true],
  ["gpt-5.5-codex-m", "Codex Max", true],
  ["short-key", "short-key", false],
  ["fixture-key-1234", "Model fixture-key-1234", false],
] as const)(
  "checks the base URL and model catalog for a reflected key (%s)",
  async (apiKey, label, accepted) => {
    const id = "gpt-5.5-codex-max";
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        Response.json(
          String(url).endsWith("/v1/models")
            ? { data: [{ id, display_name: label }] }
            : { models: [] }
        )
      );
    try {
      const connect = run(api.connectGateway, {
        preset: "cliproxyapi",
        baseUrl: "http://127.0.0.1:8317",
        apiKey,
        revision: null,
      });
      if (accepted) {
        await connect;
        expect((await run(api.gateways))[0]?.models).toMatchObject([{ id, label }]);
      } else {
        await expect(connect).rejects.toThrow("CLIProxyAPI returned an unreadable model list.");
      }
    } finally {
      fetch.mockRestore();
    }
  }
);

it("reports a rejected API key even when cancelling the 401 response body fails", async () => {
  const body = new ReadableStream({ cancel: () => Promise.reject(new Error("stream closed")) });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(body, { status: 401 }));
  try {
    await expect(
      checkCatalog({ preset: "cliproxyapi", baseUrl, apiKey: key, formats: ["messages"] })
    ).rejects.toMatchObject({
      constructor: GatewayError,
      message: "CLIProxyAPI rejected the API key.",
      details: { kind: "api_key" },
    });
  } finally {
    fetcher.mockRestore();
  }
});

it.each(["openrouter", "custom"] as const)(
  "uses only observed HTTP responses to diagnose %s",
  async (preset) => {
    const diagnostic =
      "HTTP 429, unknown provider for model, all accounts cooling (reset after 2m): ";
    const connection = {
      preset,
      baseUrl: "https://gateway.example/api",
      apiKey: key,
      formats: ["messages"] as const,
    };
    const fetcher = vi.spyOn(globalThis, "fetch");
    try {
      for (const [status, kind] of [
        [403, "api_key"],
        [429, "catalog"],
        [502, "catalog"],
      ] as const) {
        fetcher.mockResolvedValueOnce(
          new Response(diagnostic + key, {
            status,
            headers: { "Retry-After": "Tue, 24 Nov 2026 12:00:00 GMT" },
          })
        );
        await expect(checkCatalog(connection)).rejects.toMatchObject({
          details: { kind },
        });
      }
    } finally {
      fetcher.mockRestore();
    }
  }
);

it("joins published ids to the pinned client catalog, leaves unknowns in Settings and fits the runner's effort", async () => {
  const { DEFAULT_PINS } = await import("@zvada/agent-server/core");
  const publicRows = [
    { id: "gpt-6.2-astra", owned_by: "openai" },
    { id: "claude-sonnet-4-6", owned_by: "anthropic" },
    { id: "gpt-image-2", owned_by: "openai" },
    { id: "gpt-lookalike", owned_by: "openai" },
    {
      id: "vendor:vision",
      owned_by: "vendor",
      supported_endpoints: ["responses"],
      output_modalities: ["text"],
      supported_parameters: ["tools"],
    },
    {
      id: "vendor:audio",
      owned_by: "vendor",
      supported_endpoints: ["responses"],
      output_modalities: ["audio"],
      supported_parameters: ["tools"],
    },
  ];
  const rich = publicRows.map(({ id }) => ({
    slug: id,
    display_name: id === "gpt-6.2-astra" ? "GPT 6.2 Astra" : id,
    visibility: id === "gpt-image-2" ? "hide" : "list",
    default_reasoning_level: "medium",
    supported_reasoning_levels: ["medium", "high", "fictional"].map((effort) => ({ effort })),
  }));
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = new URL(String(url));
    return Response.json(
      u.searchParams.get("client_version") === DEFAULT_PINS.codex
        ? { models: [...rich, { slug: "not-published", visibility: "list" }] }
        : { data: [...publicRows, publicRows[0]] }
    );
  });
  try {
    const revision = await connectHere();
    const models = (await run(api.gateways))[0]!.models;
    expect(models).toHaveLength(6);
    expect(models[0]).toMatchObject({
      label: "GPT 6.2 Astra",
      runner: "codex-app-server",
      thinkingByFormat: { responses: { levels: ["medium", "high"], default: "medium" } },
    });
    expect(models[1]).toMatchObject({ label: "Sonnet 4.6", runner: "claude-code" });
    expect(models[2]).toMatchObject({ excluded: "hidden" });
    expect(models[3]?.runner).toBeUndefined();
    expect(models[4]?.runner).toBe("codex-app-server");
    expect(models[5]?.runner).toBeUndefined();
    await expect(
      prepared("claude-code", {
        revision,
        model: "gpt-6.2-astra",
      })
    ).rejects.toThrow();
    await expect(
      prepared("codex-app-server", {
        revision,
        model: "gpt-lookalike",
      })
    ).rejects.toThrow();
    expect(
      (
        await prepared("codex-app-server", {
          revision,
          model: "gpt-6.2-astra",
          thinkingLevel: "ultra",
        })
      ).thinkingLevel
    ).toBe("medium");
    expect(
      (
        await prepared("codex-app-server", {
          revision,
          model: "vendor:vision",
          thinkingLevel: "high",
        })
      ).thinkingLevel
    ).toBeUndefined();
  } finally {
    fetcher.mockRestore();
  }
});

it("uses published capabilities for OpenRouter even when an id is in the harness catalog", async () => {
  const fixture = {
    id: "openai/gpt-6.2-astra",
    name: "Catalog example",
    endpoints: ["/api/v1/responses"],
    reasoning: { supported_efforts: ["low", "high"] },
  };
  const rows = [
    fixture,
    {
      ...fixture,
      id: "openai/fixed",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    },
  ];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url) =>
      Response.json(String(url).endsWith("/key") ? { data: { label: "fixture" } } : { data: rows })
    );
  try {
    await run(api.connectGateway, {
      preset: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      apiKey: key,
      revision: null,
    });
    const [router] = await run(api.gateways);
    expect(router!.models[0]?.runner).toBeUndefined();
    expect(router!.models[1]?.runner).toBe("codex-app-server");
    expect(router!.models[1]?.thinkingByFormat).toBeUndefined();
  } finally {
    fetch.mockRestore();
  }
});

it("keeps the canonical Custom path and honors explicit catalog restrictions in the picker and admission", async () => {
  const { connectionFor } = await import("../../../../src/services/gateways/connections");
  const data = [
    { id: "unknown-id" },
    { id: "unspecified", supported_endpoints: null, supported_parameters: null },
    { id: "one-endpoint", endpoints: ["/api/v1/messages"] },
    { id: "other-endpoint", supported_endpoints: ["responses"] },
    { id: "embeddings", endpoints: ["/v1/embeddings"] },
    { id: "empty-list", endpoints: [] },
    { id: "hidden", visibility: "hide" },
    { id: "audio", output_modalities: ["audio"] },
    { id: "no-tools", supported_parameters: [] },
  ];
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ data }));
  try {
    await run(api.connectGateway, {
      preset: "custom",
      baseUrl: baseUrl + "/nested/v1/v1/",
      formats: ["messages", "responses"],
      apiKey: key,
      revision: null,
    });
    const gateway = (await run(api.gateways))[0]!;
    expect((await connectionFor(gateway.revision)).baseUrl).toBe(baseUrl + "/nested/v1");
    expect(gateway.models.map((m) => m.id)).toEqual(data.map((m) => m.id));
    for (const harness of ["claude-code", "codex-app-server"] as const) {
      const eligible = [
        "unknown-id",
        "unspecified",
        harness === "claude-code" ? "one-endpoint" : "other-endpoint",
      ];
      expect(
        gateway.models.filter((m) => gatewaySupports(gateway, m, harness)).map((m) => m.id)
      ).toEqual(eligible);
      for (const { id } of data) {
        const turn = prepared(harness, { revision: gateway.revision, model: id });
        if (eligible.includes(id))
          await expect(turn).resolves.toMatchObject({ execution: { model: id, harness } });
        else await expect(turn).rejects.toThrow(/no chat route/);
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    fetcher.mockRestore();
  }
});

it.each([
  {
    name: "a known OpenRouter model",
    preset: "openrouter",
    endpoints: ["responses", "messages"],
    levels: ["high", "ultra"],
    expected: { responses: { levels: ["high"] } },
  },
  {
    name: "both Custom formats",
    preset: "custom",
    endpoints: ["messages", "responses"],
    levels: ["high", "ultra"],
    expected: {
      messages: { levels: ["high"] },
      responses: { levels: ["high", "ultra"], default: "ultra" },
    },
  },
  {
    name: "one Custom format",
    preset: "custom",
    endpoints: ["responses"],
    levels: ["ultra"],
    expected: { responses: { levels: ["ultra"], default: "ultra" } },
  },
  {
    name: "two formats with efforts only Codex accepts",
    preset: "custom",
    endpoints: ["messages", "responses"],
    levels: ["ultra"],
    expected: { responses: { levels: ["ultra"], default: "ultra" } },
  },
  {
    name: "no supported efforts",
    preset: "custom",
    endpoints: ["messages", "responses"],
    levels: ["off"],
    expected: undefined,
  },
] as const)(
  "fits advertised efforts once for $name",
  async ({ preset, endpoints, levels, expected }) => {
    const row = {
      id: "openai/gpt-6-luna",
      endpoints,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools", "reasoning"],
      reasoning: { supported_efforts: levels, default_effort: "ultra" },
    };
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ data: [row] }));
    try {
      const [model] = await checkCatalog({
        preset,
        baseUrl,
        apiKey: key,
        formats: ["messages", "responses"],
      });
      expect(model).toBeDefined();
      if (expected) expect(model!.thinkingByFormat).toStrictEqual(expected);
      else expect(model).not.toHaveProperty("thinkingByFormat");
    } finally {
      fetcher.mockRestore();
    }
  }
);
