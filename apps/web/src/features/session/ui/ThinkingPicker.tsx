import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ThinkingLevel } from "@/shared/agents";

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

interface ThinkingPickerProps {
  level: ThinkingLevel;
  levels: readonly ThinkingLevel[];
  onLevelChange: (level: ThinkingLevel) => void;
}

export function ThinkingPicker({ level, levels, onLevelChange }: ThinkingPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Thinking effort"
          aria-label={`Thinking effort: ${LEVEL_LABELS[level]}`}
          className="text-text-secondary data-[state=open]:bg-accent gap-1.5 px-2 text-sm focus-visible:ring-1 has-[>svg]:px-2"
        >
          <span>{level === "xhigh" ? "X-High" : LEVEL_LABELS[level]}</span>
          <ChevronDown className="text-text-muted size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-40">
        <DropdownMenuLabel className="text-text-muted text-xs font-normal">
          Thinking effort
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={level}>
          {levels.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              onSelect={() => onLevelChange(option)}
            >
              {LEVEL_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
