/**
 * Inner vertical sidebar (~160px) for Agent Config category navigation.
 *
 * Renders icon + text labels for each category.
 * Active state: rounded-lg capsule with sidebar-accent background.
 * Mirrors SidebarMenuButton visual style without requiring SidebarProvider context.
 */

import { Zap, Terminal, Bot, Server, Webhook, type LucideIcon } from "lucide-react";
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
    <nav
      className="border-border/40 flex w-[160px] shrink-0 flex-col gap-0.5 border-r p-2"
      aria-label="Config categories"
    >
      {CATEGORY_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = activeCategory === item.id;

        return (
          <button
            key={item.id}
            type="button"
            data-active={isActive}
            onClick={() => onCategoryChange(item.id)}
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-ring data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm outline-hidden transition-colors duration-200 focus-visible:ring-2 data-[active=true]:font-medium"
          >
            <Icon className="size-4 shrink-0" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
