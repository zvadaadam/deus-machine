import { ChevronDown, Check, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import {
  getModelLabel,
  getModelOption,
  MODEL_OPTIONS,
  MODEL_PICKER_GROUPS,
  type AgentHarness,
} from "@/shared/agents";

interface ModelPickerProps {
  model: string;
  hasMessages: boolean;
  onModelChange?: (model: string) => void;
  /** Opens a new tab when switching to a locked agent group */
  onOpenNewTab?: (initialModel?: string) => void;
}

function renderAgentLogo(type: AgentHarness, sizeClass: string) {
  const Logo = getAgentLogo(type);
  if (!Logo) {
    return <span className={cn("bg-muted-foreground/80 inline-flex rounded-full", sizeClass)} />;
  }
  return <Logo className={cn("flex-shrink-0", sizeClass)} />;
}

export function ModelPicker({ model, hasMessages, onModelChange, onOpenNewTab }: ModelPickerProps) {
  const modelLabel = getModelLabel(model);
  const selectedOption = getModelOption(model);
  const selectedOptionValue = selectedOption?.value;
  const currentGroup = selectedOption?.agentHarness ?? "claude";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Select model"
          aria-label={`Select model, currently ${modelLabel}`}
          className="group gap-1.5 rounded-lg focus-visible:ring-0"
        >
          {renderAgentLogo(selectedOption?.agentHarness ?? "claude", "h-3.5 w-3.5")}
          <span className="text-text-muted text-xs font-medium">{modelLabel}</span>
          <ChevronDown className="text-text-disabled size-3 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className={cn(
          "border-border/55 w-60 rounded-xl border p-1.5",
          "from-bg-overlay/95 to-bg-elevated/94 bg-linear-to-b backdrop-blur-2xl",
          "shadow-[var(--shadow-elevated)]"
        )}
      >
        {MODEL_PICKER_GROUPS.map((agentConfig, groupIdx) => {
          /**
           * Agent type lock: once a session has messages, its agent harness
           * (claude/codex) is fixed. The user can switch models within the
           * same harness, but switching harnesses requires a new chat tab.
           */
          const isLockedGroup = hasMessages && agentConfig.id !== currentGroup;

          return (
            <div key={agentConfig.id}>
              {groupIdx > 0 && <DropdownMenuSeparator className="bg-border/70 my-1.5" />}
              <DropdownMenuLabel>
                <span className="text-text-muted/90 text-2xs px-1 font-normal tracking-wide">
                  {agentConfig.groupLabel}
                </span>
              </DropdownMenuLabel>
              {MODEL_OPTIONS.filter((o) => o.agentHarness === agentConfig.id).map((option) => {
                const isSelected = selectedOptionValue === option.value;
                return (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() =>
                      isLockedGroup ? onOpenNewTab?.(option.value) : onModelChange?.(option.value)
                    }
                    className={cn(
                      "text-text-secondary focus:bg-bg-raised/45 focus:text-text-primary",
                      "data-[highlighted]:bg-bg-raised/45 data-[highlighted]:text-text-primary",
                      "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs"
                    )}
                  >
                    {renderAgentLogo(option.agentHarness, "h-4 w-4")}
                    <span className="font-normal">{option.label}</span>
                    {option.isNew && (
                      <span className="border-accent-red-muted/60 bg-accent-red-muted/20 text-accent-red-muted text-2xs rounded-xs border px-1 py-px tracking-wide uppercase">
                        New
                      </span>
                    )}
                    <span className="ml-auto flex items-center">
                      {isSelected ? (
                        <Check className="text-text-primary h-3 w-3" />
                      ) : isLockedGroup ? (
                        <ArrowUpRight className="text-text-muted/60 h-3 w-3" />
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
