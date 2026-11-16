import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/assistants";
import { assistantCaller, operations } from "../../helpers";

const service = vi.hoisted(() => ({
  list: vi.fn(),
  setAccess: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../../src/services/assistants", () => ({
  listAssistants: service.list,
  setAssistantAccess: service.setAccess,
  removeAssistant: service.remove,
}));

import handlers from "../../../src/api/assistants";

const run = operations(handlers);
const asAssistant = operations(handlers, assistantCaller());

const CLAUDE = {
  clientId: "claude",
  name: "Claude",
  host: "claude.ai",
  access: "pending",
  createdAt: 1,
  lastSeenAt: 2,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  service.list.mockReturnValue([CLAUDE]);
  service.setAccess.mockReturnValue(true);
  service.remove.mockReturnValue(true);
});

describe("assistants", () => {
  it("answers the assistants that reached this computer", async () => {
    expect(await run(api.assistants)).toEqual([CLAUDE]);
  });
});

describe("setAssistantAccess", () => {
  it("allows read or operate, or denies, and nothing else", async () => {
    await run(api.setAssistantAccess, { clientId: "claude", access: "operate" });
    expect(service.setAccess).toHaveBeenCalledWith("claude", "operate");
    await run(api.setAssistantAccess, { clientId: "claude", access: "denied" });
    expect(service.setAccess).toHaveBeenCalledWith("claude", "denied");
    await expect(
      run(api.setAssistantAccess, { clientId: "claude", access: "pending" as never })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("says when the assistant is not known", async () => {
    service.setAccess.mockReturnValue(false);
    await expect(
      run(api.setAssistantAccess, { clientId: "nobody", access: "read" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("removeAssistant", () => {
  it("forgets the assistant, or says it was not known", async () => {
    await run(api.removeAssistant, { clientId: "claude" });
    expect(service.remove).toHaveBeenCalledWith("claude");
    service.remove.mockReturnValue(false);
    await expect(run(api.removeAssistant, { clientId: "claude" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("an assistant asking", () => {
  it("is refused all three: they are the person's, not the assistant's", async () => {
    await expect(asAssistant(api.assistants)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      asAssistant(api.setAssistantAccess, { clientId: "claude", access: "operate" })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(asAssistant(api.removeAssistant, { clientId: "claude" })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(service.setAccess).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });
});
