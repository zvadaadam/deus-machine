import {
  Fragment,
  createElement,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowUpRight, Check, ChevronDown, Search, UserRound } from "lucide-react";
import { gatewayLabel, gatewayEffort, type GatewayCatalog } from "@shared/gateways";
import { DEFAULT_THINKING_LEVEL, fitThinkingLevel } from "@shared/models";
import { getAgentLogo } from "@/assets/agents";
import { GatewayLogo } from "@/shared/agents/GatewayLogo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGlide,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Glide } from "@/components/ui/glide";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getAgentLabel,
  thinkingLevelLabel,
  type AgentHarness,
  type ThinkingLevel,
} from "@/shared/agents";
import { GatewayProviderLogo } from "@/shared/agents/GatewayProviderLogo";
import {
  modelPickerView,
  type OpenChatWithModel,
  type PickerModelList,
  type PickerOption,
} from "@/shared/agents/picker";
import { cn } from "@/shared/lib/utils";
import { uiActions } from "@/shared/stores/uiStore";

interface ModelPickerProps {
  model: string | undefined;
  agentHarness?: AgentHarness;
  lists: readonly PickerModelList[];
  gateways?: readonly GatewayCatalog[];
  previousGateway?: { ref?: string; label: string };
  previousLabel?: string;
  thinkingLevel: ThinkingLevel;
  preferredThinking?: ThinkingLevel | null;
  defaultThinking?: ThinkingLevel;
  hasMessages: boolean;
  onModelChange?: (option: PickerOption, level?: ThinkingLevel) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onOpenNewTab?: OpenChatWithModel;
  side?: "top" | "bottom";
}

function AgentLogo({ agent }: { agent: AgentHarness }) {
  const Logo = getAgentLogo(agent);
  return Logo ? (
    createElement(Logo, { className: "size-3.5 shrink-0", "aria-hidden": true })
  ) : (
    <span className="bg-muted-foreground/80 inline-flex size-3.5 rounded-full" />
  );
}

const EMPTY_GATEWAYS: readonly GatewayCatalog[] = [];

export function ModelPicker({
  model,
  agentHarness,
  lists,
  gateways = EMPTY_GATEWAYS,
  previousGateway,
  previousLabel,
  thinkingLevel,
  preferredThinking = thinkingLevel,
  defaultThinking = DEFAULT_THINKING_LEVEL,
  hasMessages,
  onModelChange,
  onThinkingLevelChange,
  onOpenNewTab,
  side = "top",
}: ModelPickerProps) {
  const [source, setSource] = useState<string>();
  const [agent, setAgent] = useState<AgentHarness>();
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState<string>();
  const focusingOnOpen = useRef(false);
  const sourceBar = useRef<HTMLDivElement>(null);
  const id = useId();
  const connected = gateways.length > 0;
  const { groups, selected } = useMemo(
    () => modelPickerView(lists, model, connected ? search : "", gateways, previousLabel),
    [lists, model, search, connected, gateways, previousLabel]
  );
  if (!agentHarness) return null;
  const selectedGateway = gateways.find((g) => g.generation === selected?.gatewayGeneration);
  const selectedSource = selected?.gatewayGeneration
    ? (selectedGateway?.ref ?? previousGateway?.ref)
    : "subscriptions";
  const requestedSource = source ?? selectedSource;
  const activeGateway = gateways.find((g) => g.ref === requestedSource);
  const shownSource = activeGateway?.ref ?? "subscriptions";
  const sources = [
    { id: "subscriptions", label: "Your subscriptions", gateway: undefined },
    ...gateways.map((g) => ({ id: g.ref, label: gatewayLabel(g, gateways), gateway: g })),
  ];
  const tabs = groups.filter((g) => g.source === shownSource);
  const shown = tabs.find((g) => g.agentHarness === (agent ?? agentHarness)) ?? tabs[0];
  const empty =
    shown?.empty ??
    (!shown && activeGateway
      ? { message: "No chat models available.", openSettings: true }
      : undefined);
  const options = shown?.options ?? [];
  const hasHeadings = options.some((option) => option.heading);
  const preview = connected
    ? (options.find((o) => o.value === highlight) ??
      options.find((o) => o.value === selected?.value) ??
      options[0])
    : selected;
  const levels = preview?.thinking?.levels;
  const changesRoute = (option: PickerOption) =>
    hasMessages &&
    (option.agentHarness !== agentHarness ||
      option.gatewayGeneration !== selected?.gatewayGeneration);
  let chatNotice: string | undefined;
  if (
    !connected &&
    hasMessages &&
    (selected?.gatewayGeneration || shown?.agentHarness !== agentHarness)
  ) {
    chatNotice = selected?.gatewayGeneration ? "Open in new chat" : "Opens a new chat";
    if (!onOpenNewTab) chatNotice = "This chat keeps its agent";
  }
  const label = selected?.label ?? model ?? getAgentLabel(agentHarness);
  const currentEffort = selected?.thinking?.levels.length
    ? thinkingLevelLabel(thinkingLevel)
    : undefined;
  const chipHint = selected?.gatewayGeneration
    ? (selectedGateway
        ? gatewayLabel(selectedGateway, gateways)
        : (previousGateway?.label ?? "Gateway")) +
      " · " +
      getAgentLabel(selected.agentHarness)
    : "Model and thinking effort";

  function levelFor(option: PickerOption) {
    if (option.value === selected?.value) return thinkingLevel;
    if (!option.thinking?.levels.length) return undefined;
    const requested = changesRoute(option) ? undefined : (preferredThinking ?? undefined);
    return option.gatewayGeneration
      ? gatewayEffort(option, requested)
      : fitThinkingLevel(requested ?? defaultThinking, option.thinking.levels, defaultThinking);
  }
  const previewLevel = preview && levelFor(preview);
  function choose(option: PickerOption, level?: ThinkingLevel) {
    if (changesRoute(option)) onOpenNewTab?.(option.value, level ?? levelFor(option));
    else if (option.value !== selected?.value)
      onModelChange?.(
        option,
        option.gatewayGeneration ? (level ?? levelFor(option) ?? "off") : level
      );
    else if (level !== undefined) onThinkingLevelChange(level);
  }
  function browse(nextSource?: string, nextAgent?: AgentHarness) {
    setSource(nextSource);
    setAgent(nextAgent);
    setSearch("");
    setHighlight(undefined);
  }

  // Radix moves within each list. Tab and the perpendicular arrows move between lists.
  function moveBetween(event: KeyboardEvent<HTMLDivElement>) {
    const { key, target, currentTarget } = event;
    if (
      !(target instanceof HTMLElement) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    const list = target.closest<HTMLElement>("[data-back],[data-forward]");
    if (!list) return;
    const stops = Array.from(
      currentTarget.querySelectorAll<HTMLElement>("[data-picker-stop=true]:not([data-disabled])")
    );
    if (key === "Enter" && target.matches("input")) {
      event.preventDefault();
      stops.find((el) => el.matches("[data-model], [data-open-providers]"))?.click();
      return;
    }
    const firstModel = key === "ArrowUp" && target === list.querySelector("[data-model]");
    const backward = key === list.dataset.back || firstModel || (key === "Tab" && event.shiftKey);
    if (!backward && key !== list.dataset.forward && key !== "Tab") return;
    const index = stops.findIndex((el) => el.closest("[data-back],[data-forward]") === list);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    stops[(index + (backward ? -1 : 1) + stops.length) % stops.length]?.focus();
  }
  const tabGlide = (
    <Glide rows="[role=tab]" selected="[aria-selected=true]" className="bg-accent rounded-lg" />
  );
  const AgentTab = connected ? Tabs.Trigger : DropdownMenuItem;
  const AgentList = connected ? Tabs.List : "div";
  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      title={chipHint}
      aria-label={
        model
          ? `Select model, currently ${label}${currentEffort ? ", thinking " + currentEffort : ""}`
          : `Select a model for ${label}`
      }
      className="text-text-secondary data-[state=open]:bg-accent gap-1.5 px-2 text-sm focus-visible:ring-1 has-[>svg]:px-2"
    >
      {selected?.gatewayGeneration ? (
        <GatewayLogo className="size-3.5" preset={selectedGateway?.preset ?? "custom"} />
      ) : (
        <AgentLogo agent={agentHarness} />
      )}
      <span>{label}</span>
      {currentEffort && <span className="text-text-muted">{currentEffort}</span>}
      <ChevronDown className="text-text-muted size-3" />
    </Button>
  );

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) browse();
      }}
    >
      {selected?.gatewayGeneration ? (
        <Tooltip>
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent className="pointer-events-none!">{chipHint}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align="start"
        side={side}
        collisionPadding={8}
        glide={false}
        {...(connected && {
          role: "dialog",
          "aria-label": "Model and thinking effort",
          "aria-labelledby": undefined,
        })}
        onFocusCapture={
          connected
            ? (event) => {
                if (event.currentTarget.contains(event.relatedTarget)) return;
                // Radix first focuses the menu's first item when it opens from the keyboard.
                queueMicrotask(() => {
                  focusingOnOpen.current = true;
                  sourceBar.current
                    ?.querySelector<HTMLElement>("[aria-selected=true]")
                    ?.focus({ preventScroll: true });
                  focusingOnOpen.current = false;
                });
              }
            : undefined
        }
        onKeyDownCapture={connected ? moveBetween : undefined}
        className={cn(
          "flex max-w-[calc(100vw-1rem)] overflow-hidden p-0",
          connected ? "h-80 w-lg" : "w-96"
        )}
      >
        {connected && (
          <Tabs.Root
            orientation="vertical"
            value={shownSource}
            onValueChange={(value) => browse(value, shown?.agentHarness ?? agentHarness)}
            asChild
          >
            <Tabs.List
              ref={sourceBar}
              data-forward="ArrowRight"
              aria-label="Account sources"
              className="bg-muted/30 border-border-subtle relative isolate flex w-11 shrink-0 flex-col items-stretch gap-1 overflow-y-auto border-r p-1 sm:w-12 pointer-coarse:w-12"
            >
              {tabGlide}
              {sources.map(({ id: sourceId, label, gateway }) => (
                <Fragment key={sourceId}>
                  <Tooltip>
                    <TooltipTrigger
                      asChild
                      onFocus={(event) => {
                        if (
                          focusingOnOpen.current ||
                          !event.currentTarget.matches(":focus-visible")
                        )
                          event.preventDefault();
                      }}
                    >
                      <Tabs.Trigger
                        value={sourceId}
                        data-picker-stop={shownSource === sourceId}
                        ref={(node) => {
                          if (node && shownSource === sourceId)
                            node.scrollIntoView({ block: "nearest" });
                        }}
                        id={id + sourceId}
                        aria-label={label}
                        aria-controls={id + "-source"}
                        className="text-text-muted aria-selected:bg-accent aria-selected:text-text-primary focus-visible:ring-ring relative flex h-9 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-1 pointer-coarse:h-11"
                      >
                        {gateway ? (
                          <GatewayLogo preset={gateway.preset} className="size-4.5" />
                        ) : (
                          <UserRound aria-hidden className="size-4.5" />
                        )}
                        {shownSource === sourceId && (
                          <span
                            aria-hidden
                            className="bg-primary absolute inset-y-2 right-0 w-0.5 rounded-full"
                          />
                        )}
                      </Tabs.Trigger>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="pointer-events-none!">
                      {label}
                    </TooltipContent>
                  </Tooltip>
                  {sourceId === "subscriptions" && (
                    <Separator decorative={false} className="bg-border-subtle my-1" />
                  )}
                </Fragment>
              ))}
            </Tabs.List>
          </Tabs.Root>
        )}
        <div
          className="flex min-w-0 flex-1 flex-col"
          role={connected ? "tabpanel" : undefined}
          id={id + "-source"}
          aria-labelledby={connected ? id + shownSource : undefined}
        >
          {activeGateway && tabs.length === 1 && shown ? (
            <div
              aria-label="Agent"
              className="text-text-secondary border-border-subtle flex shrink-0 items-center gap-1.5 border-b px-3 py-2 text-xs"
              id={id + shown.agentHarness}
            >
              <AgentLogo agent={shown.agentHarness} />
              {shown.label}
            </div>
          ) : (
            !!tabs.length && (
              <Tabs.Root
                asChild
                value={shown?.agentHarness ?? ""}
                onValueChange={(value) =>
                  browse(shownSource, tabs.find((tab) => tab.agentHarness === value)?.agentHarness)
                }
              >
                <AgentList
                  data-back="ArrowUp"
                  data-forward="ArrowDown"
                  aria-label={connected ? "Agents" : undefined}
                  className="border-border-subtle relative isolate flex shrink-0 gap-1 border-b p-1"
                >
                  {connected ? tabGlide : <DropdownMenuGlide selected="[aria-current=true]" />}
                  {tabs.map((tab) => (
                    <AgentTab
                      value={tab.agentHarness}
                      data-picker-stop={shown === tab}
                      key={tab.agentHarness}
                      id={id + tab.agentHarness}
                      aria-controls={connected ? id + "-models" : undefined}
                      aria-current={shown === tab || undefined}
                      onSelect={
                        connected
                          ? undefined
                          : (event) => {
                              event.preventDefault();
                              browse(shownSource, tab.agentHarness);
                            }
                      }
                      className={cn(
                        "flex-1 justify-center gap-1.5",
                        connected &&
                          "focus-visible:ring-ring relative flex items-center rounded-lg px-2 py-1.5 text-sm outline-none focus-visible:ring-1",
                        shown === tab ? "bg-accent text-text-primary" : "text-text-muted"
                      )}
                    >
                      <AgentLogo agent={tab.agentHarness} />
                      <span className="font-normal">{tab.label}</span>
                    </AgentTab>
                  ))}
                </AgentList>
              </Tabs.Root>
            )
          )}
          <div
            className="flex min-h-0 flex-1"
            id={id + "-models"}
            role={connected && shown ? "tabpanel" : undefined}
            aria-labelledby={connected && shown ? id + shown.agentHarness : undefined}
          >
            <div className="flex min-w-0 flex-1 flex-col">
              {connected && (
                <label className="border-border/30 flex shrink-0 items-center gap-2 border-b px-3">
                  <Search aria-hidden className="text-text-muted size-4 shrink-0" />
                  <Input
                    data-picker-stop
                    data-back="ArrowUp"
                    data-forward="ArrowDown"
                    role="searchbox"
                    aria-label="Search models"
                    placeholder="Search models…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setHighlight(undefined);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
                    }}
                    className="h-10 rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-1 focus-visible:ring-inset"
                  />
                </label>
              )}
              <div
                data-back="ArrowLeft"
                data-forward="ArrowRight"
                role={connected ? "menu" : undefined}
                aria-label={connected ? "Models" : undefined}
                className="relative isolate min-h-0 flex-1 overflow-y-auto p-1"
              >
                <DropdownMenuGlide />
                {selected?.unavailable && (!connected || activeGateway) && (
                  <DropdownMenuLabel className="text-text-muted text-xs font-normal">
                    {selected.label} is no longer available.
                  </DropdownMenuLabel>
                )}
                {empty ? (
                  <>
                    <DropdownMenuLabel className="text-text-muted text-xs font-normal break-words">
                      {empty.message}
                    </DropdownMenuLabel>
                    {empty.openSettings && (
                      <DropdownMenuItem
                        data-picker-stop={connected}
                        data-open-providers
                        onSelect={uiActions.openAISettings}
                      >
                        Open AI Providers
                      </DropdownMenuItem>
                    )}
                  </>
                ) : (
                  chatNotice && (
                    <DropdownMenuLabel className="text-text-muted text-xs font-normal">
                      {chatNotice}
                    </DropdownMenuLabel>
                  )
                )}
                {options.map((option) => {
                  const current = selected?.value === option.value;
                  const newChat = changesRoute(option);
                  return (
                    <Fragment key={option.value}>
                      {option.heading && (
                        <h3 className="text-text-muted mt-1 flex items-center gap-2 px-2 py-1.5 text-xs font-medium">
                          <GatewayProviderLogo provider={option.heading.provider} />
                          {option.heading.label}
                        </h3>
                      )}
                      <DropdownMenuItem
                        title={option.description}
                        data-model={option.value}
                        data-picker-stop={preview?.value === option.value}
                        disabled={newChat && !onOpenNewTab}
                        onSelect={() => choose(option)}
                        onFocus={connected ? () => setHighlight(option.value) : undefined}
                        className={cn(
                          current ? "text-text-primary" : "text-text-secondary",
                          hasHeadings && "pl-8"
                        )}
                      >
                        <span className="truncate font-normal">{option.label}</span>
                        <span className="ml-auto flex items-center">
                          {current ? (
                            <Check className="text-text-primary size-3" />
                          ) : newChat && onOpenNewTab ? (
                            <ArrowUpRight className="text-text-muted/60 size-3" />
                          ) : null}
                        </span>
                      </DropdownMenuItem>
                    </Fragment>
                  );
                })}
              </div>
            </div>
            <div
              data-back="ArrowLeft"
              role={connected ? "menu" : undefined}
              aria-label={connected ? "Model options" : undefined}
              className={cn(
                "border-border-subtle relative isolate shrink-0 overflow-y-auto border-l p-1",
                connected ? "flex w-28 flex-col sm:w-36" : "w-36"
              )}
            >
              <DropdownMenuGlide />
              {(!connected || (preview && (!preview.gatewayGeneration || !!levels?.length))) && (
                <DropdownMenuLabel className="text-text-muted text-xs font-normal">
                  Thinking
                </DropdownMenuLabel>
              )}
              {levels?.length && preview ? (
                <div role="group" aria-label="Thinking effort">
                  {levels.map((level) => (
                    <DropdownMenuItem
                      key={level}
                      role="menuitemradio"
                      aria-checked={level === previewLevel}
                      data-picker-stop={level === (previewLevel ?? levels[0])}
                      disabled={changesRoute(preview) && !onOpenNewTab}
                      onSelect={() => choose(preview, level)}
                      className={
                        level === previewLevel ? "text-text-primary" : "text-text-secondary"
                      }
                    >
                      <span className="font-normal">{thinkingLevelLabel(level)}</span>
                      {level === previewLevel && (
                        <Check className="text-text-primary ml-auto size-3" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </div>
              ) : (
                levels?.length === 0 && (
                  <p className="text-text-muted px-2 py-1.5 text-xs text-pretty">
                    {preview?.label} has no thinking control.
                  </p>
                )
              )}
              {connected &&
                preview &&
                changesRoute(preview) &&
                (onOpenNewTab ? (
                  <DropdownMenuItem
                    data-picker-stop
                    data-back="ArrowLeft"
                    onSelect={() => choose(preview)}
                    className="text-text-secondary mt-auto text-xs"
                  >
                    Open in new chat <ArrowUpRight aria-hidden className="size-3" />
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuLabel className="text-text-muted mt-auto text-xs font-normal">
                    This chat keeps its agent
                  </DropdownMenuLabel>
                ))}
            </div>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
