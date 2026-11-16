import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/shared/types";

// The Agent tab and the `/` menu read one rule (agentConfigOf): the folder
// where the agent runs, and nothing of this computer's for a cloud agent.

vi.mock("@/features/agent-config/ui/AgentConfigSidebar", () => ({
  AgentConfigSidebar: () => null,
}));
const { view } = vi.hoisted(() => ({
  // Each category view stands in as the project folder it was handed.
  view: async (name: string) => {
    const { createElement: h } = await import("react");
    return {
      [name]: ({ repoPath }: { repoPath?: string }) =>
        h("output", { "data-project": repoPath ?? "none" }),
    };
  },
}));
vi.mock("@/features/agent-config/ui/categories/SkillsView", () => view("SkillsView"));
vi.mock("@/features/agent-config/ui/categories/CommandsView", () => view("CommandsView"));
vi.mock("@/features/agent-config/ui/categories/AgentsView", () => view("AgentsView"));
vi.mock("@/features/agent-config/ui/categories/McpView", () => view("McpView"));
vi.mock("@/features/agent-config/ui/categories/HooksView", () => view("HooksView"));

import { AgentConfigPanel } from "@/features/agent-config/ui/AgentConfigPanel";
import { cloudSlashItems, readLocalSlashItems } from "@/features/session/hooks/useSlashCommand";
import { agentConfigOf } from "@/features/workspace/lib/reach";

const workspace = (fields: Partial<Workspace>) =>
  ({
    id: "w",
    kind: "worktree",
    repo_name: "deus",
    root_path: "/repos/deus",
    workspace_path: "/repos/deus/.deus/w",
    current_session_id: "s",
    ...fields,
  }) as Workspace;

const panel = (w: Workspace) =>
  renderToStaticMarkup(createElement(AgentConfigPanel, { workspace: w }));

describe("the Agent tab", () => {
  it("reads the workspace's own folder, not the project's main checkout", () => {
    const html = panel(workspace({}));
    expect(html).toContain('data-project="/repos/deus/.deus/w"');
    expect(html).not.toContain('data-project="/repos/deus"');
  });

  it("has no project scope before the checkout exists", () => {
    expect(panel(workspace({ current_session_id: null }))).toContain('data-project="none"');
  });

  it("says in one line that this computer's configuration does not apply to a cloud agent", () => {
    const html = panel(workspace({ kind: "cloud", workspace_path: "" }));
    expect(html).toContain("runs in the cloud");
    expect(html).toContain("this computer&#x27;s configuration does not");
    expect(html).not.toContain("data-project");
  });
});

describe("the / menu", () => {
  const read = vi.fn(async (section: string, scopeName: string, folder?: string) => [
    { name: `${scopeName}-${section}${folder ? `@${folder}` : ""}`, description: "" },
  ]);

  it("reads the same folder as the Agent tab, and this computer's own", async () => {
    read.mockClear();
    const config = agentConfigOf(workspace({}));
    expect(config).toEqual({ where: "local", folder: "/repos/deus/.deus/w" });
    const items = await readLocalSlashItems(
      config.where === "local" ? config.folder : null,
      read as never
    );
    expect(read).toHaveBeenCalledWith("skills", "project", "/repos/deus/.deus/w");
    expect(read).toHaveBeenCalledWith("commands", "project", "/repos/deus/.deus/w");
    expect(read).toHaveBeenCalledWith("skills", "global");
    expect(items.map((i) => i.name)).toEqual([
      "global-skills",
      "project-skills@/repos/deus/.deus/w",
      "global-commands",
      "project-commands@/repos/deus/.deus/w",
    ]);
  });

  it("lists nothing from this computer for a cloud agent, only what reaches it", () => {
    expect(agentConfigOf(workspace({ kind: "cloud", workspace_path: "" }))).toEqual({
      where: "cloud",
    });
    expect(cloudSlashItems(undefined)).toEqual([]);
    expect(
      cloudSlashItems([
        { name: "web-design", description: "", kind: "skill" },
        { name: "a-skill", description: "", kind: "skill" },
      ]).map((i) => i.name)
    ).toEqual(["a-skill", "web-design"]);
  });
});
