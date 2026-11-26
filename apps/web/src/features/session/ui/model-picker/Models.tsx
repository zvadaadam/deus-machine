import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import * as Cmd from "@/components/ui/command";
import { GatewayProviderLogo } from "@/shared/agents/GatewayProviderLogo";
import * as picker from "@/shared/agents/picker";
import { uiActions } from "@/shared/stores/uiStore";
import { PickerTabs } from "./Sources";

interface ModelsProps {
  page: picker.PickerPage;
  onAgent: (agent: string) => void;
  locked: boolean;
  onPick: (option: picker.PickerOption) => void;
  onClose: () => void;
  children: ReactNode;
}

function textKeys(e: KeyboardEvent<HTMLInputElement>) {
  const modified = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  if (
    ["Home", "End"].includes(e.key) ||
    (e.ctrlKey && ["j", "k", "n", "p"].includes(e.key)) ||
    (modified && ["ArrowUp", "ArrowDown"].includes(e.key))
  )
    e.stopPropagation();
}

export function Models({ page, onAgent, locked, onPick, onClose, children }: ModelsProps) {
  const { source, agents, agent, options, selected, initialModel, empty, newChat } = page;
  const sections = picker.providerGroups(options);
  const region = useId();
  const previous = useRef(page);
  // A live disconnect can remove the focused field or tab. Keep keyboard navigation in the open picker.
  useLayoutEffect(() => {
    if (previous.current !== page && document.activeElement === document.body) {
      const dialog = document
        .getElementById(region)
        ?.closest<HTMLElement>('[role="dialog"][data-state="open"]');
      const target = window.matchMedia("(pointer: coarse)").matches
        ? dialog
        : dialog?.querySelector("input");
      target?.focus({ preventScroll: true });
    }
    previous.current = page;
  }, [page, region]);
  const notice = locked ? "This chat keeps its agent" : newChat ? "Opens a new chat" : undefined;
  function openSettings() {
    onClose();
    uiActions.openAISettings();
  }
  return (
    <PickerTabs value={agent} items={agents} onChange={onAgent}>
      <Cmd.Command
        key={source + "/" + agent}
        id={region}
        label="Search models"
        vimBindings={false}
        filter={picker.filterModel}
        shouldFilter={!empty?.openSettings}
        defaultValue={initialModel}
        className="min-w-0 flex-1 rounded-none"
      >
        <Cmd.CommandInput
          placeholder="Search models…"
          onKeyDown={textKeys}
          className="focus-visible:ring-ring h-10 focus-visible:ring-1 focus-visible:ring-inset"
        />
        {selected?.unavailable && (
          <p className="text-text-muted px-3 py-1.5 text-xs">
            {selected.label} is no longer available.
          </p>
        )}
        {notice && <p className="text-text-muted px-3 py-1.5 text-xs">{notice}</p>}
        <Cmd.CommandList label="Models" className="min-h-0 flex-1">
          {empty ? (
            <p className="text-text-muted px-3 py-2 text-xs">{empty.message}</p>
          ) : (
            <Cmd.CommandEmpty>No matching models.</Cmd.CommandEmpty>
          )}
          {empty?.openSettings && (
            <Cmd.CommandItem value="open-ai-providers" onSelect={openSettings}>
              Open AI Providers
            </Cmd.CommandItem>
          )}
          {sections.map(([label, rows]) => {
            const heading = sections.length > 1 && (
              <span className="flex items-center gap-2">
                <GatewayProviderLogo provider={rows[0].provider ?? ""} />
                {label}
              </span>
            );
            return (
              <Cmd.CommandGroup key={label} value={label} heading={heading}>
                {rows.map((option) => {
                  const Mark =
                    option === selected ? Check : newChat && !locked ? ArrowUpRight : undefined;
                  return (
                    <Cmd.CommandItem
                      key={option.value}
                      value={option.value}
                      keywords={picker.modelKeywords(option)}
                      title={option.description}
                      disabled={locked}
                      onSelect={() => onPick(option)}
                      className={heading ? "pl-8" : undefined}
                    >
                      <span className="truncate">{option.label}</span>
                      {Mark && <Mark aria-hidden className="ml-auto size-3!" />}
                    </Cmd.CommandItem>
                  );
                })}
              </Cmd.CommandGroup>
            );
          })}
        </Cmd.CommandList>
      </Cmd.Command>
      {children}
    </PickerTabs>
  );
}
