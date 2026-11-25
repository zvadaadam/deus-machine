import { useState, type ReactNode } from "react";
import { match } from "ts-pattern";
import { Cloud } from "lucide-react";
import { agentConfigOf } from "@/features/workspace/lib/reach";
import { AgentConfigSidebar } from "./AgentConfigSidebar";
import { SkillsView } from "./categories/SkillsView";
import { CommandsView } from "./categories/CommandsView";
import { AgentsView } from "./categories/AgentsView";
import { McpView } from "./categories/McpView";
import { HooksView } from "./categories/HooksView";
import type { AgentConfigCategory } from "../types";
import type { Workspace } from "@/shared/types";

interface AgentConfigPanelProps {
  workspace?: Workspace;
  toolbarAction?: ReactNode;
}

export function AgentConfigPanel({ workspace, toolbarAction }: AgentConfigPanelProps) {
  const [activeCategory, setActiveCategory] = useState<AgentConfigCategory>("skills");

  // Rule 1: the configuration where the agent runs. A cloud workspace's agent
  // does not run here, so this computer's has nothing to say about it.
  const config = workspace ? agentConfigOf(workspace) : { where: "local" as const, folder: null };
  if (config.where === "cloud") return <CloudAgentConfig toolbarAction={toolbarAction} />;

  // The workspace's own folder (its checkout, where the agent runs); none
  // before it has one, so there is no project scope to read.
  const repoPath = config.folder ?? undefined;
  const repoName = workspace?.repo_name;

  const categoryProps = { repoPath, repoName, toolbarAction };

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

function CloudAgentConfig({ toolbarAction }: { toolbarAction?: ReactNode }) {
  return (
    <div
      data-slot="cloud-agent-config"
      className="bg-bg-base relative flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
    >
      {toolbarAction && <div className="absolute top-1.5 right-2">{toolbarAction}</div>}
      <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
        <Cloud className="text-text-muted/60 h-5 w-5" aria-hidden="true" />
      </div>
      <p className="text-text-secondary max-w-xs text-sm">
        This workspace's agent runs in the cloud, so this computer's configuration does not apply to
        it.
      </p>
    </div>
  );
}
