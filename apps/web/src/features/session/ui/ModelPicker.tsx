import { createElement, useState } from "react";
import { ChevronDown, Check, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import type { AgentHarness, HarnessModels, ThinkingLevel } from "@/shared/agents";
import { modelPickerView } from "@/shared/agents/picker";

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

interface ModelPickerProps {
  model: string;
  /** The models to offer (useModelLists). */
  lists: readonly HarnessModels[];
  /** The level the chat runs, and the ones its model offers; none for a model with no thinking control. */
  thinkingLevel: ThinkingLevel;
  thinkingLevels: readonly ThinkingLevel[];
  hasMessages: boolean;
  onModelChange?: (model: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  /** Opens a new tab when the choice is another agent's model in a started chat. */
  onOpenNewTab?: (initialModel?: string) => void;
  /** Where the menu opens: above a composer docked at the bottom, below one mid-screen. */
  side?: "top" | "bottom";
}

function AgentLogo({ type, className }: { type: AgentHarness; className: string }) {
  const Logo = getAgentLogo(type);
  if (!Logo) {
    return <span className={cn("bg-muted-foreground/80 inline-flex rounded-full", className)} />;
  }
  return createElement(Logo, { className: cn("flex-shrink-0", className) });
}

/**
 * The one control for what a chat runs on: its agent, its model and how hard
 * the model thinks. The trigger reads as a sentence ("Opus 5.5 High"); the menu
 * has the agents across the top, the chosen agent's models on the left and the
 * chat's model's thinking levels on the right.
 */
export function ModelPicker({
  model,
  lists,
  thinkingLevel,
  thinkingLevels,
  hasMessages,
  onModelChange,
  onThinkingLevelChange,
  onOpenNewTab,
  side = "top",
}: ModelPickerProps) {
  const { groups, selected } = modelPickerView(lists, model);
  const modelLabel = selected?.label ?? model;
  const currentAgent = selected?.agentHarness ?? "claude-code";
  // The agent whose models are shown: the chat's own until another is looked at.
  const [lookedAt, setLookedAt] = useState<AgentHarness | null>(null);
  const shownAgent = lookedAt ?? currentAgent;
  const shownGroup = groups.find((group) => group.agentHarness === shownAgent) ?? groups[0];
  // A started chat keeps its agent (the engine binds a session to one runtime):
  // another agent's model opens in a new chat.
  const opensNewChat = hasMessages && shownAgent !== currentAgent;
  const hasThinking = thinkingLevels.length > 0;

  return (
    <DropdownMenu onOpenChange={(open) => !open && setLookedAt(null)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Model and thinking effort"
          aria-label={
            hasThinking
              ? `Select model, currently ${modelLabel}, thinking ${LEVEL_LABELS[thinkingLevel]}`
              : `Select model, currently ${modelLabel}`
          }
          className="text-text-secondary data-[state=open]:bg-accent gap-1.5 px-2 text-sm focus-visible:ring-1 has-[>svg]:px-2"
        >
          <AgentLogo type={currentAgent} className="size-3.5" />
          <span>{modelLabel}</span>
          {hasThinking && <span className="text-text-muted">{LEVEL_LABELS[thinkingLevel]}</span>}
          <ChevronDown className="text-text-muted size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={side}
        collisionPadding={8}
        className="flex w-96 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0"
      >
        <div className="border-border-subtle flex shrink-0 gap-1 border-b p-1">
          {groups.map((group) => {
            const isShown = group.agentHarness === shownAgent;
            return (
              <DropdownMenuItem
                key={group.agentHarness}
                // Looking at another agent's models chooses nothing yet.
                onSelect={(event) => {
                  event.preventDefault();
                  setLookedAt(group.agentHarness);
                }}
                aria-current={isShown || undefined}
                className={cn(
                  "flex-1 justify-center gap-1.5",
                  isShown ? "bg-accent text-text-primary" : "text-text-muted"
                )}
              >
                <AgentLogo type={group.agentHarness} className="size-3.5" />
                <span className="font-normal">{group.label}</span>
              </DropdownMenuItem>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto p-1">
            {opensNewChat && (
              <DropdownMenuLabel className="text-text-muted text-xs font-normal">
                Opens a new chat
              </DropdownMenuLabel>
            )}
            {shownGroup?.options.map((option) => {
              const isSelected = selected?.value === option.value;
              return (
                <DropdownMenuItem
                  key={option.value}
                  title={option.description}
                  onSelect={() =>
                    opensNewChat ? onOpenNewTab?.(option.value) : onModelChange?.(option.value)
                  }
                  className={isSelected ? "text-text-primary" : "text-text-secondary"}
                >
                  <span className="truncate font-normal">{option.label}</span>
                  <span className="ml-auto flex items-center">
                    {isSelected ? (
                      <Check className="text-text-primary size-3" />
                    ) : opensNewChat ? (
                      <ArrowUpRight className="text-text-muted/60 size-3" />
                    ) : null}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </div>

          <div className="border-border-subtle w-36 shrink-0 overflow-y-auto border-l p-1">
            <DropdownMenuLabel className="text-text-muted text-xs font-normal">
              Thinking
            </DropdownMenuLabel>
            {hasThinking ? (
              // Rows like the models': the name under the title, the mark on the right.
              <div role="group" aria-label="Thinking effort">
                {thinkingLevels.map((level) => {
                  const isSelected = level === thinkingLevel;
                  return (
                    <DropdownMenuItem
                      key={level}
                      role="menuitemradio"
                      aria-checked={isSelected}
                      onSelect={() => onThinkingLevelChange(level)}
                      className={isSelected ? "text-text-primary" : "text-text-secondary"}
                    >
                      <span className="font-normal">{LEVEL_LABELS[level]}</span>
                      {isSelected && <Check className="text-text-primary ml-auto size-3" />}
                    </DropdownMenuItem>
                  );
                })}
              </div>
            ) : (
              <p className="text-text-muted px-2 py-1.5 text-xs text-pretty">
                {modelLabel} has no thinking control.
              </p>
            )}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
