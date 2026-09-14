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
  const currentGroup = selectedOption?.agentHarness ?? "claude-code";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Select model"
          aria-label={`Select model, currently ${modelLabel}`}
          className="text-text-secondary data-[state=open]:bg-accent gap-1.5 rounded-lg px-2 text-sm focus-visible:ring-1 has-[>svg]:px-2"
        >
          {renderAgentLogo(selectedOption?.agentHarness ?? "claude-code", "size-3.5")}
          <span>{modelLabel}</span>
          <ChevronDown className="text-text-muted size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        {MODEL_PICKER_GROUPS.map((agentConfig, groupIdx) => {
          /**
           * Agent type lock: once a session has messages, its agent harness
           * (claude/codex-server) is fixed. The user can switch models within the
           * same harness, but switching harnesses requires a new chat tab.
           */
          const isLockedGroup = hasMessages && agentConfig.id !== currentGroup;

          return (
            <div key={agentConfig.id}>
              {groupIdx > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-text-muted text-xs font-normal">
                {agentConfig.label}
              </DropdownMenuLabel>
              {MODEL_OPTIONS.filter((o) => o.agentHarness === agentConfig.id).map((option) => {
                const isSelected = selectedOptionValue === option.value;
                return (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() =>
                      isLockedGroup ? onOpenNewTab?.(option.value) : onModelChange?.(option.value)
                    }
                    className="text-text-secondary"
                  >
                    {renderAgentLogo(option.agentHarness, "h-4 w-4")}
                    <span className="font-normal">{option.label}</span>
                    {option.isNew && (
                      <span className="border-border-subtle bg-bg-muted text-text-muted text-2xs rounded-xs border px-1 py-px">
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
