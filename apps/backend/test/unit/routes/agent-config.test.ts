import { vi, describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler";

vi.mock("../../../src/services/agent-config.service", () => ({
  getMcpServers: vi.fn(() => [{ name: "test-server" }]),
  saveMcpServers: vi.fn(),
  getCommands: vi.fn(() => [{ name: "test", content: "echo test" }]),
  saveCommand: vi.fn(),
  deleteCommand: vi.fn(() => true),
  getAgents: vi.fn(() => [{ id: "agent-1" }]),
  saveAgent: vi.fn(),
  deleteAgent: vi.fn(() => true),
  getHooks: vi.fn(() => ({
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] }],
  })),
  saveHooks: vi.fn(),
  getSkills: vi.fn(() => [
    { name: "web-search", description: "Search the web", content: "# Search" },
  ]),
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(() => true),
}));

import agentConfigRoutes from "../../../src/routes/agent-config";
import {
  saveMcpServers,
  saveCommand,
  saveAgent,
  deleteCommand,
  deleteAgent,
  deleteSkill,
  saveSkill,
  saveHooks,
} from "../../../src/services/agent-config.service";

// Wrap the sub-app with error handler like the real app does
const app = new Hono();
app.route("/", agentConfigRoutes);
app.onError(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP Servers", () => {
  it("GET /agent-config/mcp-servers returns array", async () => {
    const res = await app.request("/agent-config/mcp-servers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ name: "test-server" }]);
  });

  it("POST /agent-config/mcp-servers with valid servers returns success", async () => {
    const res = await app.request("/agent-config/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servers: [{ name: "s1", command: "node" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(saveMcpServers).toHaveBeenCalledWith([{ name: "s1", command: "node" }], undefined);
  });

  it("POST /agent-config/mcp-servers with non-array servers returns 400", async () => {
    const res = await app.request("/agent-config/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servers: "not-array" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Commands", () => {
  it("GET /agent-config/commands returns array", async () => {
    const res = await app.request("/agent-config/commands");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ name: "test", content: "echo test" }]);
  });

  it("POST /agent-config/commands with valid data returns success", async () => {
    const res = await app.request("/agent-config/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "build", content: "bun run build" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(saveCommand).toHaveBeenCalledWith("build", "bun run build", undefined);
  });

  it("POST /agent-config/commands without name returns 400", async () => {
    const res = await app.request("/agent-config/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "echo test" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /agent-config/commands without content returns 400", async () => {
    const res = await app.request("/agent-config/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "build" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /agent-config/commands/:name returns success", async () => {
    const res = await app.request("/agent-config/commands/test", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("DELETE /agent-config/commands/:name returns 404 when not found", async () => {
    vi.mocked(deleteCommand).mockReturnValueOnce(false);
    const res = await app.request("/agent-config/commands/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("Agents", () => {
  it("GET /agent-config/agents returns array", async () => {
    const res = await app.request("/agent-config/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ id: "agent-1" }]);
  });

  it("POST /agent-config/agents with valid data returns success", async () => {
    const res = await app.request("/agent-config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "agent-2", name: "Test Agent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(saveAgent).toHaveBeenCalledWith("agent-2", { name: "Test Agent" }, undefined);
  });

  it("POST /agent-config/agents without id returns 400", async () => {
    const res = await app.request("/agent-config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Agent" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /agent-config/agents/:id returns success", async () => {
    const res = await app.request("/agent-config/agents/agent-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("DELETE /agent-config/agents/:id returns 404 when not found", async () => {
    vi.mocked(deleteAgent).mockReturnValueOnce(false);
    const res = await app.request("/agent-config/agents/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("Hooks", () => {
  it("GET /agent-config/hooks returns hooks object", async () => {
    const res = await app.request("/agent-config/hooks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("PreToolUse");
  });

  it("POST /agent-config/hooks with valid structured hooks returns success", async () => {
    const hooks = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] }],
    };
    const res = await app.request("/agent-config/hooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hooks }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(saveHooks).toHaveBeenCalled();
  });

  it("POST /agent-config/hooks without hooks object returns 400", async () => {
    const res = await app.request("/agent-config/hooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hooks: "not-object" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Skills", () => {
  it("GET /agent-config/skills returns array", async () => {
    const res = await app.request("/agent-config/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { name: "web-search", description: "Search the web", content: "# Search" },
    ]);
  });

  it("POST /agent-config/skills with valid data returns success", async () => {
    const res = await app.request("/agent-config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-skill", content: "# Test Skill" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(saveSkill).toHaveBeenCalledWith("test-skill", "# Test Skill", undefined);
  });

  it("POST /agent-config/skills without name returns 400", async () => {
    const res = await app.request("/agent-config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Test" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /agent-config/skills without content returns 400", async () => {
    const res = await app.request("/agent-config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-skill" }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /agent-config/skills/:name returns success", async () => {
    const res = await app.request("/agent-config/skills/web-search", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("DELETE /agent-config/skills/:name returns 404 when not found", async () => {
    vi.mocked(deleteSkill).mockReturnValueOnce(false);
    const res = await app.request("/agent-config/skills/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("Scope query params", () => {
  it("project scope passes repoPath to service", async () => {
    const res = await app.request("/agent-config/skills?scope=project&repoPath=/tmp/my-repo");
    expect(res.status).toBe(200);
  });

  it("project scope without repoPath returns 400", async () => {
    const res = await app.request("/agent-config/skills?scope=project");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("repoPath");
  });

  it("service errors propagate as 500", async () => {
    vi.mocked(deleteSkill).mockImplementationOnce(() => {
      throw new Error("disk error");
    });
    const res = await app.request("/agent-config/skills/broken", { method: "DELETE" });
    expect(res.status).toBe(500);
  });
});
