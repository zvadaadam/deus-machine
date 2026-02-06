import { Badge } from "@/components/ui/badge";
import type { MCPServer, Command, Agent } from "../../../types";

interface ExtensionsSectionProps {
  mcpServers: MCPServer[];
  commands: Command[];
  agents: Agent[];
}

export function ExtensionsSection({ mcpServers, commands, agents }: ExtensionsSectionProps) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Extensions</h3>
        <p className="text-muted-foreground mt-1 text-[13px]">
          MCP servers, commands, and agents loaded from your configuration files.
        </p>
      </div>

      <div className="space-y-8">
        {/* MCP Servers */}
        <div className="space-y-2.5">
          <h4 className="text-sm font-medium">MCP Servers</h4>
          {mcpServers.length === 0 ? (
            <EmptyState message="No MCP servers configured" />
          ) : (
            mcpServers.map((server) => (
              <div key={server.name} className="border-border/60 rounded-lg border p-3">
                <p className="text-sm font-medium">{server.name}</p>
                <code className="bg-muted/50 text-muted-foreground mt-1.5 block overflow-x-auto rounded px-2 py-1 text-xs">
                  {server.command}
                </code>
              </div>
            ))
          )}
        </div>

        {/* Commands */}
        <div className="space-y-2.5">
          <h4 className="text-sm font-medium">Custom Commands</h4>
          {commands.length === 0 ? (
            <EmptyState message="No custom commands defined" />
          ) : (
            commands.map((cmd) => (
              <div key={cmd.name} className="border-border/60 rounded-lg border p-3">
                <p className="text-sm font-medium">/{cmd.name}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{cmd.description}</p>
              </div>
            ))
          )}
        </div>

        {/* Agents */}
        <div className="space-y-2.5">
          <h4 className="text-sm font-medium">Agents</h4>
          {agents.length === 0 ? (
            <EmptyState message="Using default agents" />
          ) : (
            agents.map((agent) => (
              <div key={agent.name} className="border-border/60 rounded-lg border p-3">
                <p className="text-sm font-medium">{agent.name}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{agent.description}</p>
                {agent.tools?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {agent.tools.map((tool, i) => (
                      <Badge key={i} variant="secondary" className="text-[11px] font-normal">
                        {tool}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="border-border/60 bg-muted/20 rounded-lg border border-dashed px-4 py-8 text-center">
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  );
}
