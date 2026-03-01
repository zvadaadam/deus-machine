/**
 * Agent Config Panel — top-level container that replaces the old ConfigPanel.
 *
 * Layout: flex row (sidebar + category content). No panel-level header —
 * the parent ContentTabBar already identifies this as "Agent Config".
 * Both scopes (project + global) are always visible; no scope filter.
 */

import { match } from "ts-pattern";
import { useAgentConfigStore } from "../store/agent-config.store";
import { AgentConfigSidebar } from "./AgentConfigSidebar";
import { SkillsView } from "./categories/SkillsView";
import { CommandsView } from "./categories/CommandsView";
import { AgentsView } from "./categories/AgentsView";
import { McpView } from "./categories/McpView";
import { HooksView } from "./categories/HooksView";
import type { Workspace } from "@/shared/types";

interface AgentConfigPanelProps {
  workspace?: Workspace;
}

export function AgentConfigPanel({ workspace }: AgentConfigPanelProps) {
  const activeCategory = useAgentConfigStore((s) => s.activeCategory);
  const setActiveCategory = useAgentConfigStore((s) => s.setActiveCategory);

  const repoPath = workspace?.root_path;
  const repoName = workspace?.repo_name;

  const categoryProps = { repoPath, repoName };

  return (
    <div className="flex h-full min-h-0">
      <AgentConfigSidebar activeCategory={activeCategory} onCategoryChange={setActiveCategory} />

      {match(activeCategory)
        .with("skills", () => <SkillsView {...categoryProps} />)
        .with("commands", () => <CommandsView {...categoryProps} />)
        .with("agents", () => <AgentsView {...categoryProps} />)
        .with("mcp", () => <McpView {...categoryProps} />)
        .with("hooks", () => <HooksView {...categoryProps} />)
        .exhaustive()}
    </div>
  );
}
