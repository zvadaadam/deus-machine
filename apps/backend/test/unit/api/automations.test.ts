// The automation operations: what a frame must carry, which service call it
// becomes, and what the caller is answered. The service itself (the platform,
// the cache, the account checks) is in services/automations.service.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@shared/api/automations";
import { operations } from "../../helpers";

const service = vi.hoisted(() => ({
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  toggleAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  listAutomations: vi.fn(),
  listAutomationRuns: vi.fn(),
  runAutomationNow: vi.fn(),
  refreshAutomations: vi.fn(),
  openAutomationRun: vi.fn(),
}));
vi.mock("../../../src/services/automations", () => service);

import handlers from "../../../src/api/automations";
import { LOCAL_CALLER, Registry } from "../../../src/api/registry";

const run = operations(handlers);
const AUTOMATION = { id: "auto-1", name: "Nightly triage" };
const NEW = {
  repository_id: "repo-1",
  name: "Nightly triage",
  prompt: "Triage the new issues",
  cron: "0 9 * * *",
  timezone: "Europe/Prague",
  session_policy: "fresh_session" as const,
  model: "opus",
  thinking_level: "high",
};

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  service.createAutomation.mockResolvedValue(AUTOMATION);
  service.updateAutomation.mockResolvedValue(AUTOMATION);
  service.toggleAutomation.mockResolvedValue(AUTOMATION);
  service.deleteAutomation.mockResolvedValue(undefined);
  service.refreshAutomations.mockResolvedValue(undefined);
});

describe("the lists", () => {
  it("answer a subscriber in the same tick", () => {
    service.listAutomations.mockReturnValue([AUTOMATION]);
    service.listAutomationRuns.mockReturnValue([{ id: "run-1" }]);
    const live = new Registry(handlers);
    const ctx = { caller: LOCAL_CALLER };

    expect(live.runLive("automations", {}, ctx)).toEqual([AUTOMATION]);
    expect(live.runLive("automationRuns", { automationId: "auto-1" }, ctx)).toEqual([
      { id: "run-1" },
    ]);
    expect(service.listAutomationRuns).toHaveBeenCalledWith("auto-1");
  });

  it("runs are one automation's: the id is required", async () => {
    await expect(run(api.automationRuns, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "automationRuns requires automationId",
    });
    expect(service.listAutomationRuns).not.toHaveBeenCalled();
  });
});

describe("saveAutomation", () => {
  it("creates when no automation is named, as the person", async () => {
    expect(await run(api.saveAutomation, NEW)).toBe(AUTOMATION);
    expect(service.createAutomation).toHaveBeenCalledWith(NEW, "user");
    expect(service.updateAutomation).not.toHaveBeenCalled();
  });

  it("changes only the fields sent when one is named", async () => {
    expect(await run(api.saveAutomation, { automationId: "auto-1", name: "Renamed" })).toBe(
      AUTOMATION
    );
    // Strictly: the id is not repeated among the changes, and no field is invented.
    expect(service.updateAutomation.mock.calls).toStrictEqual([["auto-1", { name: "Renamed" }]]);
    expect(service.createAutomation).not.toHaveBeenCalled();
  });

  it("passes null through: a schedule moved back to UTC, a model cleared", async () => {
    await run(api.saveAutomation, { automationId: "auto-1", timezone: null, model: null });
    expect(service.updateAutomation.mock.calls).toStrictEqual([
      ["auto-1", { timezone: null, model: null }],
    ]);
  });

  it("leaves the wording of what a person can get wrong to the service", async () => {
    // An empty name, a schedule that is no cron, no thinking level: the right
    // types, so the service is asked, and its refusal is what the caller reads.
    const loose = { ...NEW, name: "", cron: "every day", thinking_level: null };
    service.createAutomation.mockRejectedValue(new Error("Automation needs a name."));
    await expect(run(api.saveAutomation, loose)).rejects.toThrow("Automation needs a name.");
    expect(service.createAutomation).toHaveBeenCalledWith(loose, "user");
  });

  it("an empty automationId names none: the frame creates, as it always did", async () => {
    await run(api.saveAutomation, { ...NEW, automationId: "" });
    expect(service.createAutomation).toHaveBeenCalledWith(NEW, "user");
  });

  it("refuses a new automation that leaves out what every one has", async () => {
    const { name: _name, ...nameless } = NEW;
    await expect(run(api.saveAutomation, nameless as never)).rejects.toMatchObject({
      statusCode: 400,
      message:
        "saveAutomation: expected an automationId with the fields to change, or a new automation's repository_id, name, prompt and cron",
    });
    await expect(run(api.saveAutomation, {} as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(service.createAutomation).not.toHaveBeenCalled();
  });

  it("refuses a field of the wrong type before the platform is asked anything", async () => {
    for (const bad of [
      { automationId: "auto-1", name: 7 },
      { automationId: "auto-1", session_policy: "sometimes" },
      { automationId: "auto-1", prompt: null },
      { ...NEW, session_policy: null },
    ]) {
      await expect(run(api.saveAutomation, bad as never)).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    expect(service.createAutomation).not.toHaveBeenCalled();
    expect(service.updateAutomation).not.toHaveBeenCalled();
  });
});

describe("the other writes", () => {
  it("pauses and resumes, and nothing else", async () => {
    expect(await run(api.toggleAutomation, { automationId: "auto-1", status: "paused" })).toBe(
      AUTOMATION
    );
    expect(service.toggleAutomation).toHaveBeenCalledWith("auto-1", "paused");

    await expect(
      run(api.toggleAutomation, { automationId: "auto-1", status: "deleted" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(run(api.toggleAutomation, { status: "active" } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "toggleAutomation requires automationId",
    });
    expect(service.toggleAutomation).toHaveBeenCalledTimes(1);
  });

  it("a delete the platform refuses fails; one it accepts answers nothing", async () => {
    expect(await run(api.deleteAutomation, { automationId: "auto-1" })).toBeUndefined();
    expect(service.deleteAutomation).toHaveBeenCalledWith("auto-1");

    service.deleteAutomation.mockRejectedValue(new Error("Deus Cloud said no"));
    await expect(run(api.deleteAutomation, { automationId: "auto-1" })).rejects.toThrow(
      "Deus Cloud said no"
    );
  });

  it("a run started now answers with its id", async () => {
    service.runAutomationNow.mockResolvedValue("run-9");
    expect(await run(api.runAutomationNow, { automationId: "auto-1" })).toEqual({ runId: "run-9" });
    expect(service.runAutomationNow).toHaveBeenCalledWith("auto-1");
  });

  it("refreshes one automation, or with no id the whole list", async () => {
    expect(await run(api.refreshAutomations, { automationId: "auto-1" })).toBeUndefined();
    expect(await run(api.refreshAutomations)).toBeUndefined();
    expect(service.refreshAutomations.mock.calls).toEqual([["auto-1"], [undefined]]);
  });

  it("opening a run answers with the workspace and chat to show", async () => {
    service.openAutomationRun.mockResolvedValue({ workspaceId: "ws-1", sessionId: "sess-1" });
    expect(await run(api.openAutomationRun, { runId: "run-9" })).toEqual({
      workspaceId: "ws-1",
      sessionId: "sess-1",
    });
    await expect(run(api.openAutomationRun, {} as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "openAutomationRun requires runId",
    });
    expect(service.openAutomationRun).toHaveBeenCalledTimes(1);
  });
});
