import { Settings2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAgents, useMCPServers, useSettings } from "@/features/settings/api/settings.queries";

export function ConfigPanel() {
  const settings = useSettings().data;
  const mcpServersQuery = useMCPServers();
  const agentsQuery = useAgents();

  const mcpServers = mcpServersQuery.data || [];
  const agents = agentsQuery.data || [];

  const provider = settings?.claude_provider || "Anthropic";
  const model = settings?.claude_model || "Default model";
  const contextWindowLabel = "Not available";
  const contextWindowPercent = "0%";

  return (
    <div className="flex h-full flex-col">
      <div className="border-border/40 flex h-9 items-center gap-2 border-b px-4">
        <Settings2 className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">Agent Config</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-5 p-4">
          <section className="space-y-2">
            <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Model
            </p>
            <div className="border-border/40 bg-muted/30 flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
              <span className="text-muted-foreground">Provider</span>
              <span className="text-foreground font-medium">{provider}</span>
            </div>
            <div className="border-border/40 bg-muted/30 flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
              <span className="text-muted-foreground">Model</span>
              <span className="text-foreground font-medium">{model}</span>
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              MCP Servers
            </p>
            {mcpServers.length === 0 ? (
              <div className="border-border/40 text-muted-foreground bg-muted/30 rounded-lg border border-dashed px-3 py-4 text-xs">
                No MCP servers configured
              </div>
            ) : (
              <div className="border-border/40 divide-border/40 overflow-hidden rounded-lg border">
                {mcpServers.map((server, index) => (
                  <div
                    key={`${server.name}-${index}`}
                    className="border-border/40 flex items-start justify-between gap-3 border-b px-3 py-2 text-xs last:border-b-0"
                  >
                    <div className="text-foreground font-medium">{server.name}</div>
                    <div className="text-muted-foreground truncate font-mono">{server.command}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Loaded Skills
            </p>
            {agents.length === 0 ? (
              <div className="border-border/40 text-muted-foreground bg-muted/30 rounded-lg border border-dashed px-3 py-4 text-xs">
                Using default agents
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {agents.map((agent) => (
                  <span
                    key={agent.id}
                    className="border-border/40 bg-muted/40 text-foreground rounded-full border px-2.5 py-1 text-xs font-medium"
                  >
                    {agent.name}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                Context Window
              </p>
              <span className="text-muted-foreground text-xs">{contextWindowLabel}</span>
            </div>
            <div className="bg-muted/40 h-2 w-full overflow-hidden rounded-full">
              <div
                className="bg-success/60 h-full rounded-full"
                style={{
                  width: contextWindowPercent,
                }}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              Context usage metrics are not wired yet.
            </p>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
