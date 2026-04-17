import { vi, describe, it, expect, beforeEach } from "vitest";
import path from "path";
import os from "os";

// vi.mock is hoisted to the top, so we cannot reference variables declared
// outside the factory. Use vi.hoisted() to create mock functions that are
// available at hoist time.
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => [] as string[]),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("fs", () => ({
  default: mockFs,
  existsSync: (...args: any[]) => mockFs.existsSync(...args),
  readFileSync: (...args: any[]) => mockFs.readFileSync(...args),
  writeFileSync: (...args: any[]) => mockFs.writeFileSync(...args),
  mkdirSync: (...args: any[]) => mockFs.mkdirSync(...args),
  readdirSync: (...args: any[]) => mockFs.readdirSync(...args),
  unlinkSync: (...args: any[]) => mockFs.unlinkSync(...args),
  rmSync: (...args: any[]) => mockFs.rmSync(...args),
}));

// Import after mock so ensureDirectories() runs with mocked fs
import {
  getMcpServers,
  saveMcpServers,
  getCommands,
  saveCommand,
  deleteCommand,
  getAgents,
  saveAgent,
  deleteAgent,
  getHooks,
  saveHooks,
  getSkills,
  saveSkill,
  deleteSkill,
  CLAUDE_DIR,
  COMMANDS_DIR,
  AGENTS_DIR,
  SETTINGS_PATH,
} from "../../../src/services/agent-config.service";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default return values
  mockFs.existsSync.mockReturnValue(true);
  mockFs.readFileSync.mockReturnValue("{}");
  mockFs.readdirSync.mockReturnValue([]);
});

describe("getMcpServers", () => {
  it("returns parsed servers array when file has valid JSON", () => {
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        mcpServers: {
          "test-server": { command: "node", args: ["--flag"], env: { KEY: "val" } },
          "other-server": { command: "python" },
        },
      })
    );

    const servers = getMcpServers();
    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({
      name: "test-server",
      command: "node",
      args: ["--flag"],
      env: { KEY: "val" },
    });
    expect(servers[1]).toEqual({
      name: "other-server",
      command: "python",
      args: [],
      env: {},
    });
  });

  it("returns empty array when file does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    const servers = getMcpServers();
    expect(servers).toEqual([]);
  });

  it("returns empty array when config has no mcpServers key", () => {
    mockFs.readFileSync.mockReturnValue("{}");
    const servers = getMcpServers();
    expect(servers).toEqual([]);
  });
});

describe("saveMcpServers", () => {
  it("calls writeFileSync with correct path and JSON content", () => {
    const servers = [
      { name: "my-server", command: "node", args: ["index.js"], env: { PORT: "3000" } },
    ];
    saveMcpServers(servers);

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [, content] = mockFs.writeFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.mcpServers["my-server"]).toEqual({
      command: "node",
      args: ["index.js"],
      env: { PORT: "3000" },
    });
  });
});

describe("getCommands", () => {
  it("reads .md files from commands directory", () => {
    mockFs.readdirSync.mockReturnValue(["build.md", "deploy.md", "readme.txt"] as any);
    mockFs.readFileSync.mockImplementation((filePath: any) => {
      if (typeof filePath === "string" && filePath.includes("build.md")) {
        return "# Build Project\nbun run build";
      }
      if (typeof filePath === "string" && filePath.includes("deploy.md")) {
        return "# Deploy\nkubectl apply";
      }
      return "{}";
    });

    const commands = getCommands();
    // Only .md files are included
    expect(commands).toHaveLength(2);
    expect(commands[0].name).toBe("build");
    expect(commands[0].description).toBe("Build Project");
    expect(commands[0].content).toContain("bun run build");
    expect(commands[1].name).toBe("deploy");
  });

  it("returns empty array when directory does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    const commands = getCommands();
    expect(commands).toEqual([]);
  });
});

describe("saveCommand", () => {
  it("calls writeFileSync with correct path", () => {
    saveCommand("build", "# Build\nbun run build");
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      path.join(COMMANDS_DIR, "build.md"),
      "# Build\nbun run build"
    );
  });
});

describe("deleteCommand", () => {
  it("calls unlinkSync when file exists", () => {
    mockFs.existsSync.mockReturnValue(true);
    const result = deleteCommand("build");
    expect(result).toBe(true);
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(path.join(COMMANDS_DIR, "build.md"));
  });

  it("returns false when file does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = deleteCommand("nonexistent");
    expect(result).toBe(false);
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe("getAgents", () => {
  it("reads .json files from agents directory", () => {
    mockFs.readdirSync.mockReturnValue(["agent-1.json", "agent-2.json", "notes.txt"] as any);
    mockFs.readFileSync.mockImplementation((filePath: any) => {
      if (typeof filePath === "string" && filePath.includes("agent-1.json")) {
        return JSON.stringify({ name: "Coder", tools: ["edit"] });
      }
      if (typeof filePath === "string" && filePath.includes("agent-2.json")) {
        return JSON.stringify({ name: "Reviewer" });
      }
      return "{}";
    });

    const agents = getAgents();
    expect(agents).toHaveLength(2);
    expect(agents[0].id).toBe("agent-1");
    expect(agents[0].name).toBe("Coder");
    expect(agents[1].id).toBe("agent-2");
    expect(agents[1].name).toBe("Reviewer");
  });

  it("returns empty array when directory does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    const agents = getAgents();
    expect(agents).toEqual([]);
  });
});

describe("saveAgent", () => {
  it("calls writeFileSync with correct path and stringified data", () => {
    saveAgent("agent-1", { name: "Coder", tools: ["edit"] });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      path.join(AGENTS_DIR, "agent-1.json"),
      JSON.stringify({ name: "Coder", tools: ["edit"] }, null, 2)
    );
  });
});

describe("deleteAgent", () => {
  it("calls unlinkSync when file exists", () => {
    mockFs.existsSync.mockReturnValue(true);
    const result = deleteAgent("agent-1");
    expect(result).toBe(true);
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(path.join(AGENTS_DIR, "agent-1.json"));
  });

  it("returns false when file does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = deleteAgent("nonexistent");
    expect(result).toBe(false);
  });
});

describe("getHooks", () => {
  it("reads hooks from settings.json", () => {
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        hooks: { preCommit: "lint", postMerge: "install" },
      })
    );

    const hooks = getHooks();
    expect(hooks).toEqual({ preCommit: "lint", postMerge: "install" });
  });

  it("returns empty object when settings.json does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    const hooks = getHooks();
    expect(hooks).toEqual({});
  });

  it("returns empty object when settings has no hooks key", () => {
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: "dark" }));
    const hooks = getHooks();
    expect(hooks).toEqual({});
  });
});

describe("saveHooks", () => {
  it("merges hooks into existing settings and writes", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ theme: "dark" }));

    saveHooks({ preCommit: "lint" });

    const [, content] = mockFs.writeFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.theme).toBe("dark");
    expect(parsed.hooks).toEqual({ preCommit: "lint" });
  });

  it("creates new settings file when none exists", () => {
    mockFs.existsSync.mockReturnValue(false);

    saveHooks({ prePush: "test" });

    const [, content] = mockFs.writeFileSync.mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed.hooks).toEqual({ prePush: "test" });
  });
});

describe("getSkills", () => {
  it("reads skills from directories containing SKILL.md", () => {
    mockFs.readdirSync.mockReturnValue([{ name: "code-simplifier" }, { name: "notes.txt" }] as any);
    mockFs.existsSync.mockImplementation((target: any) => {
      if (target === path.join(CLAUDE_DIR, "skills")) return true;
      if (target === path.join(CLAUDE_DIR, "skills", "code-simplifier", "SKILL.md")) return true;
      if (target === path.join(CLAUDE_DIR, "skills", "notes.txt", "SKILL.md")) return false;
      return true;
    });
    mockFs.readFileSync.mockReturnValue(`---\ndescription: Simplifies code\n---\n# Skill`);

    const skills = getSkills();

    expect(skills).toEqual([
      {
        name: "code-simplifier",
        description: "Simplifies code",
        content: `---\ndescription: Simplifies code\n---\n# Skill`,
      },
    ]);
  });

  it("supports symlinked skill directories", () => {
    mockFs.readdirSync.mockReturnValue([{ name: "frontend-developer" }] as any);
    mockFs.existsSync.mockImplementation((target: any) => {
      if (target === path.join(CLAUDE_DIR, "skills")) return true;
      if (target === path.join(CLAUDE_DIR, "skills", "frontend-developer", "SKILL.md")) {
        return true;
      }
      return true;
    });
    mockFs.readFileSync.mockReturnValue(`---\ndescription: Build React UIs\n---\n# Skill`);

    const skills = getSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "frontend-developer",
      description: "Build React UIs",
    });
  });

  it("returns empty array when skills directory does not exist", () => {
    mockFs.existsSync.mockImplementation(
      (target: any) => target !== path.join(CLAUDE_DIR, "skills")
    );

    expect(getSkills()).toEqual([]);
  });
});

describe("saveSkill", () => {
  it("writes SKILL.md inside the skill directory", () => {
    saveSkill("test-skill", "# Test Skill");

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      path.join(CLAUDE_DIR, "skills", "test-skill", "SKILL.md"),
      "# Test Skill"
    );
  });
});

describe("deleteSkill", () => {
  it("removes the skill directory when it exists", () => {
    mockFs.existsSync.mockImplementation((target: any) => {
      return target === path.join(CLAUDE_DIR, "skills", "test-skill");
    });

    const result = deleteSkill("test-skill");

    expect(result).toBe(true);
  });

  it("returns false when the skill directory does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);

    expect(deleteSkill("missing-skill")).toBe(false);
  });
});
