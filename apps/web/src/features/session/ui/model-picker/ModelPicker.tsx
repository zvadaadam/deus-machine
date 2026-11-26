import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ThinkingLevel } from "@/shared/agents";
import * as picker from "@/shared/agents/picker";
import { cn } from "@/shared/lib/utils";
import { Models } from "./Models";
import { PickerMark, PickerTabs } from "./PickerTabs";
import { Thinking } from "./Thinking";

interface ModelPickerProps extends picker.PickerChat {
  onModelChange?: (option: picker.PickerOption, level?: ThinkingLevel) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onOpenNewTab?: picker.OpenChatWithModel;
  side?: "top" | "bottom";
}

function touchFocus(event: Event) {
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  event.preventDefault();
  (event.target as HTMLElement).focus({ preventScroll: true });
}

export function ModelPicker(props: ModelPickerProps) {
  const { model, agentHarness, gateways, thinkingLevel, onOpenNewTab, side = "top" } = props;
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState<{ source: string; agent?: string }>();
  const { lists, previousLabel } = props;
  const catalog = useMemo(
    () => picker.modelPickerView(lists, model, gateways, previousLabel),
    [lists, model, gateways, previousLabel]
  );
  if (!agentHarness) return null;
  const page = picker.pickerPage(props, catalog, browse);
  const { source, selected, label, chipName, effort, preset, hint, newChat } = page;
  function changeOpen(next: boolean) {
    if (next) setBrowse(undefined);
    setOpen(next);
  }
  const close = () => setOpen(false);
  function choose(option: picker.PickerOption) {
    if (newChat) onOpenNewTab?.(option.value, picker.levelFor(option, props, true));
    else if (option !== selected) {
      if (option.gatewayRevision)
        props.onModelChange?.(option, picker.levelFor(option, props, false) ?? "off");
      else props.onModelChange?.(option);
    }
    close();
  }
  function chooseLevel(level: ThinkingLevel) {
    props.onThinkingLevelChange(level);
    close();
  }
  const chip = (
    <Button
      type="button"
      title={hint}
      aria-label={chipName}
      variant="ghost"
      size="sm"
      className="text-text-secondary data-[state=open]:bg-accent gap-1.5 px-2 text-sm focus-visible:ring-1 has-[>svg]:px-2 [&>svg:first-child]:size-3.5"
    >
      <PickerMark value={agentHarness} preset={preset} />
      <span>{label}</span>
      {effort && <span className="text-text-muted">{effort}</span>}
      <ChevronDown className="text-text-muted size-3" />
    </Button>
  );
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <Tooltip>
        <PopoverTrigger asChild>
          {selected?.gatewayRevision ? <TooltipTrigger asChild>{chip}</TooltipTrigger> : chip}
        </PopoverTrigger>
        {selected?.gatewayRevision && (
          <TooltipContent className="pointer-events-none!" onEscapeKeyDown={close}>
            {hint}
          </TooltipContent>
        )}
      </Tooltip>
      <PopoverContent
        aria-label="Model and thinking effort"
        side={side}
        align="start"
        collisionPadding={8}
        onOpenAutoFocus={touchFocus}
        className={cn(
          "flex h-80 max-h-(--radix-popover-content-available-height) max-w-[calc(100vw-1rem)] overflow-hidden p-0",
          gateways?.length ? "w-lg" : "w-96"
        )}
      >
        <PickerTabs
          vertical
          value={source}
          items={page.sources}
          onChange={(next) => setBrowse({ source: next, agent: page.agent || agentHarness })}
          onClose={close}
        >
          <Models
            page={page}
            onAgent={(agent) => setBrowse({ source, agent })}
            locked={newChat && !onOpenNewTab}
            onPick={choose}
            onClose={close}
          >
            <Thinking model={selected} level={thinkingLevel} onPick={chooseLevel} />
          </Models>
        </PickerTabs>
      </PopoverContent>
    </Popover>
  );
}
