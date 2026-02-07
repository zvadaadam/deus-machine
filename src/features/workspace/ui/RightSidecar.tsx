import { Code2, Settings2, Terminal, PenTool, Globe } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { RightSideTab } from "@/features/workspace/store";

interface RightSidecarProps {
  activeTab: RightSideTab;
  onTabChange: (tab: RightSideTab) => void;
  /** Compact mode — disables non-code tabs when diff viewer is active */
  compact?: boolean;
}

const sidecarItems: Array<{
  id: RightSideTab;
  label: string;
  icon: typeof Code2;
}> = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "config", label: "Config", icon: Settings2 },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "design", label: "Design", icon: PenTool },
  { id: "browser", label: "Browser", icon: Globe },
];

export function RightSidecar({ activeTab, onTabChange, compact }: RightSidecarProps) {
  return (
    <div className="bg-background/60 border-border/20 flex h-full w-14 flex-shrink-0 flex-col items-center gap-2 border-l px-1.5 py-3 backdrop-blur-sm">
      {sidecarItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        const isDisabled = compact && item.id !== "code";
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={isActive}
            disabled={isDisabled}
            title={isDisabled ? `Close diff to use ${item.label}` : undefined}
            onClick={() => !isDisabled && onTabChange(item.id)}
            className={cn(
              "group flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium tracking-tight transition-colors",
              isDisabled
                ? "cursor-not-allowed opacity-40"
                : isActive
                  ? "text-foreground"
                  : "text-muted-foreground/80 hover:text-foreground"
            )}
          >
            <div
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors",
                isDisabled
                  ? "border-border/20 bg-muted/20 text-muted-foreground/40"
                  : isActive
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border/40 bg-muted/40 text-muted-foreground group-hover:bg-muted/70 group-hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
            </div>
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
