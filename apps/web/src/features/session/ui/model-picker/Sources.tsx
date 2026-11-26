import { createElement, Fragment, type PropsWithChildren } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { UserRound } from "lucide-react";
import { getAgentLogo } from "@/assets/agents";
import { Glide } from "@/components/ui/glide";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GatewayLogo } from "@/shared/agents/GatewayLogo";
import type { PickerTab } from "@/shared/agents/picker";

export function PickerMark({ value, preset }: Pick<PickerTab, "value" | "preset">) {
  if (preset) return <GatewayLogo preset={preset} />;
  return createElement(getAgentLogo(value) ?? UserRound, { "aria-hidden": true });
}

interface Strip extends PropsWithChildren {
  items: PickerTab[];
  value: string;
  onChange: (value: string) => void;
  vertical?: boolean;
  onClose?: () => void;
}

export function PickerTabs({ items, value, onChange, vertical, onClose, children }: Strip) {
  const multiple = items.length > 1;
  const strip = vertical
    ? "bg-muted/30 w-11 flex-col overflow-y-auto border-r sm:w-12"
    : "border-b";
  const item = vertical
    ? "h-9 shrink-0 pointer-coarse:h-11 [&>svg]:size-4.5 aria-selected:after:absolute aria-selected:after:inset-y-2 aria-selected:after:right-0 aria-selected:after:w-0.5 aria-selected:after:rounded-full aria-selected:after:bg-primary"
    : "min-w-0 flex-1 gap-1.5 px-1 py-1.5 [&>svg]:size-3.5";
  return (
    <Tabs.Root
      value={value}
      onValueChange={onChange}
      orientation={vertical ? "vertical" : "horizontal"}
      className={vertical ? "flex min-w-0 flex-1" : "flex min-h-0 flex-1 flex-col"}
    >
      {multiple && (
        <Tabs.List
          aria-label={vertical ? "Account sources" : "Agents"}
          className={`border-border-subtle relative isolate flex shrink-0 gap-1 p-1 ${strip}`}
        >
          <Glide
            rows="[role=tab]"
            selected="[aria-selected=true]"
            className="bg-accent rounded-lg"
          />
          {items.map((choice, index) => {
            const tab = (
              <Tabs.Trigger
                key={choice.value}
                value={choice.value}
                aria-label={choice.label}
                ref={(node) => {
                  if (vertical && value === choice.value)
                    node?.scrollIntoView({ block: "nearest" });
                }}
                className={`text-text-muted aria-selected:bg-accent aria-selected:text-text-primary focus-visible:ring-ring relative flex items-center justify-center rounded-lg text-sm outline-none focus-visible:ring-1 [&>svg]:shrink-0 ${item}`}
              >
                <PickerMark {...choice} />
                {!vertical && <span className="truncate">{choice.label}</span>}
              </Tabs.Trigger>
            );
            if (!vertical) return tab;
            return (
              <Fragment key={choice.value}>
                <Tooltip>
                  <TooltipTrigger asChild>{tab}</TooltipTrigger>
                  <TooltipContent
                    side="left"
                    onEscapeKeyDown={onClose}
                    className="pointer-events-none!"
                  >
                    {choice.label}
                  </TooltipContent>
                </Tooltip>
                {index === 0 && <Separator decorative={false} className="bg-border-subtle my-1" />}
              </Fragment>
            );
          })}
        </Tabs.List>
      )}
      {!vertical && items.length === 1 && (
        <div
          aria-label="Agent"
          className="text-text-secondary border-border-subtle flex items-center gap-1.5 border-b px-3 py-2 text-xs [&>svg]:size-3.5"
        >
          <PickerMark {...items[0]} />
          {items[0].label}
        </div>
      )}
      <Tabs.Content
        value={value}
        tabIndex={-1}
        {...(!multiple && { role: "presentation", "aria-labelledby": undefined })}
        className={vertical ? "flex min-w-0 flex-1 flex-col" : "flex min-h-0 flex-1"}
      >
        {children}
      </Tabs.Content>
    </Tabs.Root>
  );
}
