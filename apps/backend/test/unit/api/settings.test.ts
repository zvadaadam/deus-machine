import { vi, describe, it, expect, beforeEach } from "vitest";
import * as api from "@shared/api/settings";
import { operations } from "../../helpers";

vi.mock("../../../src/services/settings.service", () => ({
  getAllSettings: vi.fn(() => ({ theme: "dark", lang: "en" })),
  saveSetting: vi.fn(),
  getSetting: vi.fn(() => null),
  PRIVATE_SETTINGS: new Set(["relay_machines"]),
}));

// What follows from turning remote access on or off.
const remote = vi.hoisted(() => ({
  reconcileRelay: vi.fn(),
  invalidateRemoteGateCache: vi.fn(),
  disconnectDirectDevices: vi.fn(),
  syncKeepAwake: vi.fn(),
}));
vi.mock("../../../src/services/relay.service", () => ({ reconcileRelay: remote.reconcileRelay }));
vi.mock("../../../src/middleware/remote-gate", () => ({
  invalidateRemoteGateCache: remote.invalidateRemoteGateCache,
}));
vi.mock("../../../src/services/ws.service", () => ({
  disconnectDirectDevices: remote.disconnectDirectDevices,
}));
vi.mock("../../../src/services/keep-awake.service", () => ({
  syncKeepAwake: remote.syncKeepAwake,
}));

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

// The local agents as the engine has them, and the folders that exist on this computer.
const agents = vi.hoisted(() => ({
  connected: true,
  status: vi.fn(),
  models: vi.fn(),
  prepareClis: vi.fn(),
  signIn: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  logout: vi.fn(),
  workspace: vi.fn(),
  folders: new Set<string>(),
}));
vi.mock("../../../src/services/agent", () => ({
  getLocalAgents: () => {
    if (!agents.connected) throw new Error("Agent server not connected");
    return agents;
  },
}));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => ({}) }));
vi.mock("../../../src/db", () => ({ getWorkspaceForMiddleware: agents.workspace }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: (path: string) => agents.folders.has(path),
}));
vi.mock("../../../src/services/agent/cloud/models", () => ({ getCloudModelLists: vi.fn() }));

import handlers from "../../../src/api/settings";
import { getAllSettings, saveSetting } from "../../../src/services/settings.service";
import {
  getSkills,
  saveMcpServers,
  saveCommand,
  saveAgent,
  deleteCommand,
  deleteAgent,
  deleteSkill,
  saveSkill,
  saveHooks,
} from "../../../src/services/agent-config.service";
import { getCloudModelLists } from "../../../src/services/agent/cloud/models";

const run = operations(handlers);

beforeEach(() => {
  vi.clearAllMocks();
  agents.connected = true;
  agents.folders.clear();
});

describe("settings", () => {
  it("answers this computer's preferences", async () => {
    expect(await run(api.settings)).toEqual({ theme: "dark", lang: "en" });
    expect(getAllSettings).toHaveBeenCalled();
  });
});

describe("saveSetting", () => {
  it("stores the value under its key", async () => {
    await run(api.saveSetting, { key: "theme", value: "light" });
    expect(saveSetting).toHaveBeenCalledWith("theme", "light");
  });

  it("refuses to write this computer's machine secrets", async () => {
    await expect(run(api.saveSetting, { key: "relay_machines", value: {} })).rejects.toMatchObject({
      statusCode: 400,
      message: "relay_machines is not a setting",
    });
    expect(saveSetting).not.toHaveBeenCalled();
  });

  it("requires a key", async () => {
    await expect(run(api.saveSetting, { value: "light" } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "saveSetting requires key",
    });
    await expect(run(api.saveSetting, { key: "", value: "light" })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(saveSetting).not.toHaveBeenCalled();
  });

  it("opens remote access at once: the gate, the tunnel and the keep-awake report", async () => {
    await run(api.saveSetting, { key: "remote_access_enabled", value: true });
    expect(saveSetting).toHaveBeenCalledWith("remote_access_enabled", true);
    expect(remote.invalidateRemoteGateCache).toHaveBeenCalledOnce();
    // Turning it on is also how a computer removed from the account is added again.
    expect(remote.reconcileRelay).toHaveBeenCalledExactlyOnceWith({ restart: true });
    expect(remote.disconnectDirectDevices).not.toHaveBeenCalled();
    expect(remote.syncKeepAwake).toHaveBeenCalledOnce();
  });

  it("closes remote access at once, dropping the devices on the local network", async () => {
    await run(api.saveSetting, { key: "remote_access_enabled", value: false });
    expect(remote.invalidateRemoteGateCache).toHaveBeenCalledOnce();
    expect(remote.reconcileRelay).toHaveBeenCalledExactlyOnceWith({ restart: false });
    expect(remote.disconnectDirectDevices).toHaveBeenCalledOnce();
    expect(remote.syncKeepAwake).toHaveBeenCalledOnce();
  });

  it("reports keep-awake again when its own setting changes, and leaves the tunnel alone", async () => {
    await run(api.saveSetting, { key: "remote_keep_awake", value: false });
    expect(remote.syncKeepAwake).toHaveBeenCalledOnce();
    expect(remote.reconcileRelay).not.toHaveBeenCalled();
    expect(remote.invalidateRemoteGateCache).not.toHaveBeenCalled();
  });

  it("does nothing more for any other preference", async () => {
    await run(api.saveSetting, { key: "theme", value: "light" });
    for (const effect of Object.values(remote)) expect(effect).not.toHaveBeenCalled();
  });
});

describe("agentConfig", () => {
  it("answers each section as its files read", async () => {
    expect(await run(api.agentConfig, { section: "mcp-servers" })).toEqual([
      { name: "test-server" },
    ]);
    expect(await run(api.agentConfig, { section: "commands" })).toEqual([
      { name: "test", content: "echo test" },
    ]);
    expect(await run(api.agentConfig, { section: "agents" })).toEqual([{ id: "agent-1" }]);
    expect(await run(api.agentConfig, { section: "hooks" })).toHaveProperty("PreToolUse");
    expect(await run(api.agentConfig, { section: "skills" })).toEqual([
      { name: "web-search", description: "Search the web", content: "# Search" },
    ]);
  });

  it("reads this computer's own configuration unless a project is asked for", async () => {
    await run(api.agentConfig, { section: "skills" });
    expect(getSkills).toHaveBeenLastCalledWith(undefined);
    await run(api.agentConfig, { section: "skills", scope: "global", repoPath: "/tmp/my-repo" });
    expect(getSkills).toHaveBeenLastCalledWith(undefined);
    await run(api.agentConfig, { section: "skills", scope: "project", repoPath: "/tmp/my-repo" });
    expect(getSkills).toHaveBeenLastCalledWith("/tmp/my-repo");
  });

  it("refuses project scope without the project's folder", async () => {
    await expect(
      run(api.agentConfig, { section: "skills", scope: "project" })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("repoPath"),
    });
    expect(getSkills).not.toHaveBeenCalled();
  });

  it("refuses a section or a scope it does not know", async () => {
    await expect(run(api.agentConfig, { section: "plugins" as never })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      run(api.agentConfig, { section: "skills", scope: "team" as never })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(run(api.agentConfig, {} as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("saveAgentConfig", () => {
  it("replaces the MCP servers", async () => {
    await run(api.saveAgentConfig, {
      section: "mcp-servers",
      servers: [{ name: "s1", command: "node" }],
    });
    expect(saveMcpServers).toHaveBeenCalledWith([{ name: "s1", command: "node" }], undefined);
  });

  it("refuses MCP servers that are not a list", async () => {
    await expect(
      run(api.saveAgentConfig, { section: "mcp-servers", servers: "not-array" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(saveMcpServers).not.toHaveBeenCalled();
  });

  it("saves a command, which needs a name and content", async () => {
    await run(api.saveAgentConfig, {
      section: "commands",
      name: "build",
      content: "bun run build",
    });
    expect(saveCommand).toHaveBeenCalledWith("build", "bun run build", undefined);

    await expect(
      run(api.saveAgentConfig, { section: "commands", content: "echo test" } as never)
    ).rejects.toMatchObject({ statusCode: 400, message: "saveAgentConfig requires name" });
    await expect(
      run(api.saveAgentConfig, { section: "commands", name: "build" } as never)
    ).rejects.toMatchObject({ statusCode: 400, message: "saveAgentConfig requires content" });
    expect(saveCommand).toHaveBeenCalledOnce();
  });

  it("saves an agent under its id, and nothing but the agent in its file", async () => {
    await run(api.saveAgentConfig, { section: "agents", id: "agent-2", name: "Test Agent" });
    expect(saveAgent).toHaveBeenCalledWith("agent-2", { name: "Test Agent" }, undefined);
    // The file is written as JSON: no section, scope or id may reach it.
    expect(JSON.parse(JSON.stringify(vi.mocked(saveAgent).mock.calls[0][1]))).toEqual({
      name: "Test Agent",
    });

    await expect(
      run(api.saveAgentConfig, { section: "agents", name: "Test Agent" } as never)
    ).rejects.toMatchObject({ statusCode: 400, message: "saveAgentConfig requires id" });
  });

  it("replaces the hooks, keeping fields it does not know", async () => {
    const hooks = {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "lint.sh", async: true }] },
      ],
    };
    await run(api.saveAgentConfig, { section: "hooks", hooks });
    expect(saveHooks).toHaveBeenCalledWith(hooks, undefined);

    await expect(
      run(api.saveAgentConfig, { section: "hooks", hooks: "not-object" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(saveHooks).toHaveBeenCalledOnce();
  });

  it("saves a skill, which needs a name and content", async () => {
    await run(api.saveAgentConfig, {
      section: "skills",
      name: "test-skill",
      content: "# Test Skill",
    });
    expect(saveSkill).toHaveBeenCalledWith("test-skill", "# Test Skill", undefined);

    await expect(
      run(api.saveAgentConfig, { section: "skills", content: "# Test" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      run(api.saveAgentConfig, { section: "skills", name: "test-skill" } as never)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(saveSkill).toHaveBeenCalledOnce();
  });

  it("saves into a project's folder for project scope, and needs the folder", async () => {
    await run(api.saveAgentConfig, {
      section: "skills",
      name: "test-skill",
      content: "# Test Skill",
      scope: "project",
      repoPath: "/tmp/my-repo",
    });
    expect(saveSkill).toHaveBeenCalledWith("test-skill", "# Test Skill", "/tmp/my-repo");

    await expect(
      run(api.saveAgentConfig, {
        section: "skills",
        name: "test-skill",
        content: "# Test Skill",
        scope: "project",
      })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("repoPath") });
    expect(saveSkill).toHaveBeenCalledOnce();
  });
});

describe("deleteAgentConfig", () => {
  it("deletes one command, agent or skill", async () => {
    await run(api.deleteAgentConfig, { section: "commands", itemId: "test" });
    expect(deleteCommand).toHaveBeenCalledWith("test", undefined);
    await run(api.deleteAgentConfig, { section: "agents", itemId: "agent-1" });
    expect(deleteAgent).toHaveBeenCalledWith("agent-1", undefined);
    await run(api.deleteAgentConfig, {
      section: "skills",
      itemId: "web-search",
      scope: "project",
      repoPath: "/tmp/my-repo",
    });
    expect(deleteSkill).toHaveBeenCalledWith("web-search", "/tmp/my-repo");
  });

  it("says which item was not there", async () => {
    vi.mocked(deleteCommand).mockReturnValueOnce(false);
    await expect(
      run(api.deleteAgentConfig, { section: "commands", itemId: "nonexistent" })
    ).rejects.toMatchObject({ statusCode: 404, message: "Command 'nonexistent' not found" });

    vi.mocked(deleteAgent).mockReturnValueOnce(false);
    await expect(
      run(api.deleteAgentConfig, { section: "agents", itemId: "nonexistent" })
    ).rejects.toMatchObject({ statusCode: 404, message: "Agent 'nonexistent' not found" });

    vi.mocked(deleteSkill).mockReturnValueOnce(false);
    await expect(
      run(api.deleteAgentConfig, { section: "skills", itemId: "nonexistent" })
    ).rejects.toMatchObject({ statusCode: 404, message: "Skill 'nonexistent' not found" });
  });

  it("refuses the sections that are saved whole", async () => {
    for (const section of ["mcp-servers", "hooks"]) {
      await expect(
        run(api.deleteAgentConfig, { section, itemId: "PreToolUse" } as never)
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("passes a failure of the files on", async () => {
    vi.mocked(deleteSkill).mockImplementationOnce(() => {
      throw new Error("disk error");
    });
    await expect(
      run(api.deleteAgentConfig, { section: "skills", itemId: "broken" })
    ).rejects.toThrow("disk error");
  });
});

describe("agentAuth", () => {
  it("answers each agent's CLI and login as the engine has them", async () => {
    const answer = { auth: [], clis: [], logins: [] };
    agents.status.mockResolvedValue(answer);
    expect(await run(api.agentAuth)).toBe(answer);
  });

  it("answers why the engine could not be asked, rather than failing the read", async () => {
    agents.connected = false;
    expect(await run(api.agentAuth)).toEqual({
      auth: [],
      clis: [],
      logins: [],
      error: "Agent server not connected",
    });

    agents.connected = true;
    agents.status.mockRejectedValue(new Error("status timed out"));
    expect(await run(api.agentAuth)).toMatchObject({ auth: [], error: "status timed out" });
  });
});

describe("agentModels", () => {
  const LISTS = [{ harness: "claude-code", source: "live", fetchedAt: 1, models: [] }];

  beforeEach(() => {
    agents.models.mockResolvedValue(LISTS);
  });

  it("answers what this computer's CLIs list", async () => {
    expect(await run(api.agentModels)).toEqual({ lists: LISTS });
    expect(agents.models).toHaveBeenCalledWith(undefined);
  });

  it("asks for a workspace's own folder, whose settings can narrow the list", async () => {
    agents.workspace.mockReturnValue({ kind: "worktree", root_path: "/repo", slug: "berlin" });
    agents.folders.add("/repo/.deus/berlin");
    await run(api.agentModels, { workspaceId: "ws-1" });
    expect(agents.workspace).toHaveBeenCalledWith(expect.anything(), "ws-1");
    expect(agents.models).toHaveBeenCalledWith("/repo/.deus/berlin");
  });

  it("asks for no folder when the workspace has none on this computer", async () => {
    for (const workspace of [
      undefined,
      { kind: "cloud", root_path: "/repo", slug: "berlin" },
      // An archived workspace's folder is gone.
      { kind: "worktree", root_path: "/repo", slug: "gone" },
    ]) {
      agents.workspace.mockReturnValue(workspace);
      await run(api.agentModels, { workspaceId: "ws-1" });
      expect(agents.models).toHaveBeenLastCalledWith(undefined);
    }
  });
});

describe("cloudModels", () => {
  const LISTS = [
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
      ],
    },
  ];

  it("answers the platform's lists as listModels() returns them", async () => {
    vi.mocked(getCloudModelLists).mockResolvedValue(LISTS as never);
    expect(await run(api.cloudModels)).toEqual({ configured: true, lists: LISTS });
  });

  it("answers no lists, not an error, without a cloud account to ask", async () => {
    vi.mocked(getCloudModelLists).mockResolvedValue(null);
    expect(await run(api.cloudModels)).toEqual({ configured: false, lists: [] });
  });

  it("says what failed when the platform cannot be read", async () => {
    vi.mocked(getCloudModelLists).mockRejectedValue(new Error("Request timed out"));
    await expect(run(api.cloudModels)).rejects.toMatchObject({
      statusCode: 502,
      message: "Request timed out",
    });
  });
});

describe("the local agents' CLIs and logins", () => {
  const auth = { harness: "claude-code", state: "signed_in", methods: [] };

  it("starts the CLI install and answers at once", async () => {
    expect(await run(api.agentPrepareClis)).toBeUndefined();
    expect(agents.prepareClis).toHaveBeenCalledOnce();
  });

  it("signs in with the method asked for, and answers what the engine did", async () => {
    const answer = { login: { loginId: "login-1", url: "https://claude.ai/oauth" } };
    agents.signIn.mockResolvedValue(answer);
    expect(await run(api.agentSignIn, { harness: "claude-code", method: "claudeai" })).toBe(answer);
    expect(agents.signIn).toHaveBeenCalledWith("claude-code", "claudeai", undefined);
  });

  it("passes a key trimmed, and a blank one as none", async () => {
    await run(api.agentSignIn, { harness: "claude-code", method: "console", apiKey: " sk-1 " });
    expect(agents.signIn).toHaveBeenLastCalledWith("claude-code", "console", "sk-1");
    await run(api.agentSignIn, { harness: "claude-code", method: "console", apiKey: "   " });
    expect(agents.signIn).toHaveBeenLastCalledWith("claude-code", "console", undefined);
  });

  it("refuses a harness that does not run on this computer, and a sign-in with no method", async () => {
    await expect(
      run(api.agentSignIn, { harness: "cursor" as never, method: "claudeai" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(run(api.agentSignIn, { harness: "claude-code" } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "agentSignIn requires method",
    });
    await expect(run(api.agentLogout, { harness: "cursor" as never })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(agents.signIn).not.toHaveBeenCalled();
    expect(agents.logout).not.toHaveBeenCalled();
  });

  it("finishes a sign-in with its code, and answers the login it made", async () => {
    agents.complete.mockResolvedValue(auth);
    expect(await run(api.agentLoginCode, { loginId: "login-1", code: "code#state" })).toEqual({
      auth,
    });
    expect(agents.complete).toHaveBeenCalledWith("login-1", "code#state");
    await expect(run(api.agentLoginCode, { loginId: "login-1" } as never)).rejects.toMatchObject({
      statusCode: 400,
      message: "agentLoginCode requires code",
    });
  });

  it("cancels a sign-in", async () => {
    expect(await run(api.agentLoginCancel, { loginId: "login-1" })).toBeUndefined();
    expect(agents.cancel).toHaveBeenCalledWith("login-1");
  });

  it("signs an agent out and answers what its login is now", async () => {
    const signedOut = { ...auth, state: "signed_out" };
    agents.logout.mockResolvedValue(signedOut);
    expect(await run(api.agentLogout, { harness: "codex-app-server" })).toEqual({
      auth: signedOut,
    });
    expect(agents.logout).toHaveBeenCalledWith("codex-app-server");
  });

  it("says the engine is not connected when it is not", async () => {
    agents.connected = false;
    await expect(
      run(api.agentSignIn, { harness: "claude-code", method: "claudeai" })
    ).rejects.toThrow("Agent server not connected");
  });
});
