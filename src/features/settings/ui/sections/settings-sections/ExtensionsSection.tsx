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
        <p className="text-muted-foreground mt-1 text-base">
          MCP servers, commands, and agents loaded from your configuration files.
        </p>
      </div>

      <div className="space-y-8">
        {/* MCP Servers */}
        <ConfigGroup
          title="MCP Servers"
          emptyMessage="No MCP servers configured"
          isEmpty={mcpServers.length === 0}
        >
          {mcpServers.map((server) => (
            <ConfigItem key={server.name} title={server.name}>
              <code className="bg-muted/50 text-muted-foreground mt-1.5 block overflow-x-auto rounded px-2 py-1 text-xs">
                {server.command}
              </code>
            </ConfigItem>
          ))}
        </ConfigGroup>

        {/* Commands */}
        <ConfigGroup
          title="Custom Commands"
          emptyMessage="No custom commands defined"
          isEmpty={commands.length === 0}
        >
          {commands.map((cmd) => (
            <ConfigItem key={cmd.name} title={`/${cmd.name}`} description={cmd.description} />
          ))}
        </ConfigGroup>

        {/* Agents */}
        <ConfigGroup
          title="Agents"
          emptyMessage="Using default agents"
          isEmpty={agents.length === 0}
        >
          {agents.map((agent) => (
            <ConfigItem key={agent.name} title={agent.name} description={agent.description}>
              {agent.tools?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {agent.tools.map((tool) => (
                    <Badge key={tool} variant="secondary" className="text-xs font-normal">
                      {tool}
                    </Badge>
                  ))}
                </div>
              )}
            </ConfigItem>
          ))}
        </ConfigGroup>
      </div>
    </div>
  );
}

function ConfigGroup({
  title,
  emptyMessage,
  isEmpty,
  children,
}: {
  title: string;
  emptyMessage: string;
  isEmpty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <h4 className="text-sm font-medium">{title}</h4>
      {isEmpty ? (
        <div className="border-border/60 bg-muted/20 rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-muted-foreground text-sm">{emptyMessage}</p>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function ConfigItem({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-border/60 rounded-lg border p-3">
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
      {children}
    </div>
  );
}
