import { Check } from "lucide-react";
import { thinkingLevelLabel, type ThinkingLevel } from "@/shared/agents";
import type { PickerOption } from "@/shared/agents/picker";
import { Glide } from "@/components/ui/glide";

interface ThinkingProps {
  model?: PickerOption;
  level: ThinkingLevel;
  onPick: (level: ThinkingLevel) => void;
}

export function Thinking({ model, level, onPick }: ThinkingProps) {
  const levels = model?.thinking?.levels ?? (model?.gatewayRevision ? [] : undefined);
  return (
    <div className="border-border-subtle w-28 shrink-0 overflow-y-auto border-l p-1 sm:w-36">
      <p className="text-text-muted px-2 py-1.5 text-xs">Thinking</p>
      {levels?.length ? (
        <div role="radiogroup" aria-label="Thinking effort" className="relative isolate">
          <Glide rows="[role=radio]" className="bg-accent rounded-lg" />
          {levels.map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={choice === level}
              onClick={() => onPick(choice)}
              className="text-text-secondary aria-checked:text-text-primary focus-visible:ring-ring flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset"
            >
              <span>{thinkingLevelLabel(choice)}</span>
              {choice === level && <Check aria-hidden className="size-3" />}
            </button>
          ))}
        </div>
      ) : (
        levels && (
          <p className="text-text-muted px-2 py-1.5 text-xs text-pretty">
            {model?.label} has no thinking control.
          </p>
        )
      )}
    </div>
  );
}
