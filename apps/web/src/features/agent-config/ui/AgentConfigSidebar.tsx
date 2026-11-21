/**
 * Inner vertical sidebar (~160px) for Agent Config category navigation.
 *
 * Renders icon + text labels for each category.
 * Active state: rounded-lg capsule with sidebar-accent background.
 * Mirrors SidebarMenuButton visual style without requiring SidebarProvider context.
 */

import { Zap, Terminal, Bot, Server, Webhook, type LucideIcon } from "lucide-react";
import { Glide } from "@/components/ui/glide";
import type { AgentConfigCategory } from "../types";

const CATEGORY_ITEMS: Array<{
  id: AgentConfigCategory;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "skills", label: "Skills", icon: Zap },
  { id: "commands", label: "Commands", icon: Terminal },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "mcp", label: "MCP", icon: Server },
  { id: "hooks", label: "Hooks", icon: Webhook },
];

interface AgentConfigSidebarProps {
  activeCategory: AgentConfigCategory;
  onCategoryChange: (category: AgentConfigCategory) => void;
}

export function AgentConfigSidebar({ activeCategory, onCategoryChange }: AgentConfigSidebarProps) {
  return (
    <div className="border-border/40 w-[160px] shrink-0 border-r p-2">
      <nav className="relative isolate flex flex-col gap-0.5" aria-label="Config categories">
        <Glide
          rows="button"
          selected="[data-active=true]"
          className="bg-sidebar-accent rounded-lg"
        />
        {CATEGORY_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeCategory === item.id;

          return (
            <button
              key={item.id}
              type="button"
              data-active={isActive}
              onClick={() => onCategoryChange(item.id)}
              className="control-interaction text-muted-foreground hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm data-[active=true]:font-medium"
            >
              <Icon className="size-4 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
