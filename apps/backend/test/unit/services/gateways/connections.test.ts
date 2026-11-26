import {
  useGatewayFixture,
  run,
  dir,
  baseUrl,
  model,
  key,
  probes,
  connectHere,
  prepared,
  chat,
} from "./setup";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { LOCAL_CALLER } from "../../../../src/api/registry";
import { ValidationError } from "../../../../src/lib/errors";
import { claimTurn, forgetChatTurns } from "../../../../src/services/agent/chat-turn";
import { gatewayCredential } from "../../../../src/services/gateways/turn";
import { getAllSettings } from "../../../../src/services/settings.service";
import gatewayHandlers from "../../../../src/api/gateways";
import { operations, assistantCaller } from "../../../helpers";

useGatewayFixture();

function mockCatalogRead(base: string) {
  const { fetch } = globalThis;
  const read = vi.fn<() => Promise<Response>>();
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
    String(url) === base + "/v1/models" ? read() : fetch(url, init)
  );
  return read;
}

it("accepts a loopback gateway with a fresh identity and keeps the key out of reads", async () => {
  const input = { preset: "cliproxyapi" as const, baseUrl, apiKey: key, revision: null };
  const loopback = "Use a loopback address on 127.0.0.1, localhost or [::1].";
  for (const [bad, reason] of [
    ["http://127.1", loopback],
    ["http://localhost@localhost", "Enter the API key in its own field."],
    ["http://localhost/f", loopback],
    ["http://10.0.0.2", loopback],
  ] as const)
    await expect(run(api.connectGateway, { ...input, baseUrl: bad })).rejects.toThrow(reason);
  const beforeReads = probes;
  await expect(run(api.connectGateway, { ...input, apiKey: "refused" })).rejects.toThrow(
    "rejected the API key"
  );
  expect(await run(api.gateways)).toEqual([]);
  await run(api.connectGateway, input);
  expect(probes).toBe(beforeReads + 2);
  const [status] = await run(api.gateways);
  expect(status?.ref).toMatch(/^[0-9a-f-]{36}$/);
  expect(status?.models).toContainEqual({
    id: model,
    provider: "",
    label: model,
    runner: "claude-code",
  });
  expect(JSON.stringify(status)).not.toContain(key);
  expect(getAllSettings()).not.toHaveProperty("gateways");
  expect((await readFile(join(dir, "preferences.json"), "utf8")).includes(key)).toBe(false);
});

it.each([
  ["synthetic-fixture", "synthetic-fixture", "Enter the API key in its own field."],
  ["%73ynthetic-fixture", "synthetic-fixture", "Enter the API key in its own field."],
  ["team/short/models", "short", "Enter the API key in its own field."],
  ["team/short%2Fkey/models", "short/key", "Enter the API key in its own field."],
  ["bad%", "synthetic-fixture", "Enter a gateway base URL without a query or fragment."],
  ["%FF", "synthetic-fixture", "Enter a gateway base URL without a query or fragment."],
])(
  "rejects a Custom address containing the key or a malformed escape (%s)",
  async (path, apiKey, message) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network request"));
    try {
      await expect(
        run(api.connectGateway, {
          preset: "custom",
          baseUrl: "https://fixture.invalid/" + path,
          apiKey,
          revision: null,
          formats: ["responses"],
        })
      ).rejects.toMatchObject({ constructor: ValidationError, message });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  }
);

it.each([
  ["openrouter", "https://other.example/api", /official/],
  ["custom", "http://remote.example/api", /HTTPS/],
  ["cliproxyapi", "https://remote.example", /loopback/],
] as const)(
  "validates a previously sealed %s destination before delivering a key",
  async (preset, baseUrl, error) => {
    const { initVault, seal } = await import("../../../../src/services/integrations/vault");
    const { saveSetting } = await import("../../../../src/services/settings.service");
    const { connectionFor } = await import("../../../../src/services/gateways/connections");
    await initVault("seal");
    const credential = seal({ baseUrl, apiKey: key, formats: ["responses"], models: [] });
    const revision = crypto.randomUUID();
    saveSetting("gateways", [{ ref: crypto.randomUUID(), revision, preset, credential }]);
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No outbound requests"));
    try {
      await expect(connectionFor(revision)).rejects.toThrow(error);
      await expect(run(api.refreshGateway, { revision })).rejects.toThrow(error);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  }
);

it("seals independent gateways, validates the OpenRouter key, and binds the requested format, model and revision", async () => {
  const { connectionFor } = await import("../../../../src/services/gateways/connections");
  const requests: string[] = [];
  const customKey = randomBytes(24).toString("hex");
  const fixture = {
    data: [
      {
        id: "openai/example",
        name: "Example GPT",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        endpoints: ["/api/v1/responses", "/api/v1/messages"],
        supported_parameters: ["tools", "reasoning"],
        reasoning: { supported_efforts: ["low", "high", "unsupported"], default_effort: "high" },
      },
      {
        id: "anthropic/example",
        name: "Example Claude",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        endpoints: ["/api/v1/messages"],
        supported_parameters: ["tools"],
      },
      {
        id: "example/image",
        name: "Image",
        architecture: { input_modalities: ["text"], output_modalities: ["image"] },
        supported_parameters: ["tools"],
      },
      {
        id: "example/input",
        architecture: { input_modalities: ["image"], output_modalities: ["text"] },
        supported_parameters: ["tools"],
      },
      {
        id: "example/plain",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: [],
      },
      {
        id: "example/chat-only",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools"],
        endpoints: ["/v1/chat/completions"],
      },
    ],
  };
  const { fetch: realFetch } = globalThis;
  let rejectSavedKey = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    requests.push(url.pathname + url.search);
    if (url.hostname === "gateway.example")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + customKey);
    expect(init?.redirect).toBe("manual");
    const accepted = new Headers(init?.headers).get("authorization") === "Bearer " + key;
    if (url.pathname.endsWith("/key"))
      return Response.json(
        { data: { label: "fixture" } },
        { status: accepted && !rejectSavedKey ? 200 : 401 }
      );
    if (!url.pathname.endsWith("/models")) return new Response(null, { status: 404 });
    return Response.json(fixture);
  });
  const managed = {
    preset: "openrouter" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    revision: null,
    apiKey: key,
  };
  try {
    const original = await connectHere();
    await expect(run(api.connectGateway, { ...managed, apiKey: "rejected" })).rejects.toThrow(
      /key/i
    );
    fetch.mockResolvedValueOnce(new Response("Public landing page"));
    await expect(run(api.connectGateway, managed)).rejects.toThrow(/verify|key/i);
    const privateKey = {
      ...managed,
      preset: "custom" as const,
      baseUrl: "https://gateway.example/team/v1",
      apiKey: customKey,
      formats: ["responses" as const],
    };
    await expect(run(api.connectGateway, { ...privateKey, formats: [] })).rejects.toThrow();
    await Promise.all([run(api.connectGateway, managed), run(api.connectGateway, privateKey)]);
    const all = await run(api.gateways);
    expect(all).toHaveLength(3);
    for (const secret of [key, customKey]) expect(JSON.stringify(all)).not.toContain(secret);
    expect(getAllSettings()).not.toHaveProperty("gateways");
    expect((await readFile(join(dir, "preferences.json"), "utf8")).includes(key)).toBe(false);
    const router = all.find((g) => g.preset === "openrouter")!;
    const custom = all.find((g) => g.preset === "custom")!;
    expect(router.models.map((m) => m.runner)).toEqual([
      "codex-app-server",
      "claude-code",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(custom.models.map((m) => m.id)).toEqual(fixture.data.map((m) => m.id));
    expect(router.models[0]).toMatchObject({
      label: "Example GPT",
      provider: "openai",
      thinkingByFormat: { responses: { levels: ["low", "high"], default: "high" } },
    });
    expect(requests).toContain("/api/v1/key");
    expect(requests).toContain("/api/v1/models");
    expect(requests).toContain("/team/v1/models");
    expect(requests.some((p) => p.includes("client_version"))).toBe(false);
    rejectSavedKey = true;
    await expect(
      run(api.connectGateway, { ...managed, revision: router.revision, apiKey: undefined })
    ).rejects.toThrow("rejected the API key");
    rejectSavedKey = false;
    await expect(
      run(api.connectGateway, {
        ...privateKey,
        baseUrl: "https://elsewhere.example",
        revision: custom.revision,
        apiKey: undefined,
      })
    ).rejects.toThrow(/key/i);
    expect((await connectionFor(custom.revision)).apiKey).toBe(customKey);
    const sid = chat(),
      tid = crypto.randomUUID();
    const turn = await prepared("claude-code", {
      revision: router.revision,
      model: "anthropic/example",
    });
    claimTurn(sid, tid, undefined, undefined, turn);
    try {
      expect(turn.execution.via).toBe("OpenRouter");
      expect(
        await gatewayCredential({ sessionId: sid, turnId: tid, harness: "claude-code" })
      ).toMatchObject({ type: "api_key", apiKey: key, baseUrl: "https://openrouter.ai/api" });
      const codex = await prepared("codex-app-server", {
        revision: custom.revision,
        model: "openai/example",
      });
      const secondId = chat();
      claimTurn(secondId, tid, undefined, undefined, codex);
      const credential = await gatewayCredential({
        sessionId: secondId,
        turnId: tid,
        harness: "codex-app-server",
      });
      expect(credential).toMatchObject({
        baseUrl: "https://gateway.example/team/v1",
        binding: { ref: custom.ref, revision: custom.revision, format: "responses" },
      });
      await expect(
        prepared("claude-code", {
          revision: custom.revision,
          model: "anthropic/example",
        })
      ).rejects.toThrow(/route/i);
      await run(api.connectGateway, {
        ...privateKey,
        formats: ["messages"],
        revision: custom.revision,
        apiKey: undefined,
      });
      await expect(connectionFor(custom.revision)).rejects.toThrow(/changed/i);
      expect((await run(api.gateways)).find((g) => g.ref === custom.ref)?.revision).not.toBe(
        custom.revision
      );
      expect((await connectionFor(original)).baseUrl).toBe(baseUrl);
      expect((await connectionFor(router.revision)).apiKey).toBe(key);
    } finally {
      forgetChatTurns(sid);
    }
  } finally {
    fetch.mockRestore();
  }
});

it("validates a gateway destination and a request from this computer before touching the network", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("unexpected network"));
  try {
    const input = {
      preset: "custom" as const,
      baseUrl: "https://gateway.example/api",
      formats: ["messages" as const],
      apiKey: key,
      revision: null,
    };
    for (const caller of [
      { ...LOCAL_CALLER, relayed: true },
      { ...LOCAL_CALLER, deviceId: "paired" },
      assistantCaller(),
    ]) {
      const remote = operations(gatewayHandlers, caller);
      await expect(remote(api.connectGateway, input)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        remote(api.disconnectGateway, { revision: crypto.randomUUID() })
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    for (const baseUrl of [
      "http://example.org",
      "http://127.1",
      "http://localhost.example",
      "https://user:pass@gateway.example",
      "https://gateway.example?token=secret",
      "https://gateway.example/#frag",
      "file:///tmp/key",
    ])
      await expect(run(api.connectGateway, { ...input, baseUrl })).rejects.toThrow();
    await expect(
      run(api.connectGateway, {
        ...input,
        preset: "cliproxyapi",
        baseUrl: "https://gateway.example",
      })
    ).rejects.toThrow();
    await expect(
      run(api.connectGateway, { ...input, preset: "openrouter", baseUrl: "http://localhost" })
    ).rejects.toThrow();
    await expect(run(api.connectGateway, { ...input, preset: "openrouter" })).rejects.toThrow(
      /OpenRouter/
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it("lets this computer replace an unreadable saved key without reusing its revision", async () => {
  const { saveSetting } = await import("../../../../src/services/settings.service");
  const revision = crypto.randomUUID();
  const ref = crypto.randomUUID();
  saveSetting("gateways", [{ ref, preset: "cliproxyapi", revision, credential: "unreadable" }]);
  expect((await run(api.gateways))[0]?.problem).toBeDefined();
  await expect(
    run(api.connectGateway, { preset: "cliproxyapi", baseUrl, revision })
  ).rejects.toThrow();
  await run(api.connectGateway, { preset: "cliproxyapi", baseUrl, apiKey: key, revision });
  const [restored] = await run(api.gateways);
  expect(restored).toMatchObject({ ref, preset: "cliproxyapi", baseUrl });
  expect(restored?.revision).not.toBe(revision);
  expect(restored?.problem).toBeUndefined();
});

it("has no account inventory or management key on the wire", () => {
  for (const name of ["gatewayAccounts", "gatewayOfferings", "setGatewayManagementKey"])
    expect(api).not.toHaveProperty(name);
});

it("shares a pending gateway catalog refresh and reads again after failure or success", async () => {
  await run(api.connectGateway, {
    preset: "custom",
    baseUrl,
    apiKey: key,
    formats: ["responses"],
    revision: null,
  });
  const { revision } = (await run(api.gateways))[0]!;
  const waiting = Promise.withResolvers<void>();
  const fetcher = mockCatalogRead(baseUrl).mockImplementation(async () => {
    await waiting.promise;
    return new Response(null, { status: 503 });
  });
  const refresh = () => run(api.refreshGateway, { revision });
  const readers = Promise.allSettled([
    refresh(),
    refresh(),
    run(api.connectGateway, { preset: "custom", baseUrl, revision }),
  ]);
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
  } finally {
    waiting.resolve();
  }
  expect((await readers).map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await run(api.gateways))[0]?.problem?.kind).toBe("catalog");
  fetcher.mockImplementation(async () => Response.json({ data: [{ id: "new" }] }));
  await Promise.all([refresh(), refresh()]);
  expect((await run(api.gateways))[0]).toMatchObject({
    models: [{ id: "new" }],
    problem: undefined,
  });
  await refresh();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("refreshes an edited gateway while its previous revision still has a read in flight", async () => {
  const input = {
    preset: "custom" as const,
    baseUrl,
    apiKey: key,
    formats: ["responses" as const],
    revision: null,
  };
  await run(api.connectGateway, input);
  const old = (await run(api.gateways))[0]!;
  const waiting = Promise.withResolvers<void>();
  const fetcher = mockCatalogRead(baseUrl).mockImplementation(async () =>
    Response.json({ data: [{ id: "current" }] })
  );
  fetcher.mockImplementationOnce(async () => {
    await waiting.promise;
    return Response.json({ data: [{ id: "old" }] });
  });
  const oldRead = run(api.refreshGateway, { revision: old.revision });
  try {
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await run(api.connectGateway, {
      ...input,
      revision: old.revision,
      apiKey: randomBytes(24).toString("hex"),
    });
    const current = (await run(api.gateways))[0]!;
    expect(current.ref).toBe(old.ref);
    expect(current.revision).not.toBe(old.revision);
    await run(api.refreshGateway, { revision: current.revision });
  } finally {
    waiting.resolve();
  }
  await expect(oldRead).rejects.toThrow("connection changed");
  expect((await run(api.gateways))[0]?.models.map((m) => m.id)).toEqual(["current"]);
});

it("reopens the sealed Custom catalog with each runner's fitted efforts", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      data: [
        {
          id: "both",
          reasoning: { supported_efforts: ["high", "ultra"], default_effort: "ultra" },
        },
      ],
    })
  );
  try {
    await run(api.connectGateway, {
      preset: "custom",
      baseUrl,
      apiKey: key,
      revision: null,
      formats: ["messages", "responses"],
    });
    const [saved] = await run(api.gateways);
    const expected = {
      messages: { levels: ["high"] },
      responses: { levels: ["high", "ultra"], default: "ultra" },
    };
    expect(saved!.models[0]!.thinkingByFormat).toStrictEqual(expected);
    const { stdout } = await promisify(execFile)(
      "bun",
      [
        "--no-env-file",
        "-e",
        "const {connectionFor}=await import(process.argv[1]); const {models}=await connectionFor(process.argv[2]); console.log(JSON.stringify(models[0].thinkingByFormat));",
        new URL("../../../../src/services/gateways/connections.ts", import.meta.url).href,
        saved!.revision,
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        env: { ...process.env, DATABASE_PATH: join(dir, "deus.db") },
      }
    );
    expect(JSON.parse(stdout)).toStrictEqual(expected);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    fetcher.mockRestore();
  }
});
