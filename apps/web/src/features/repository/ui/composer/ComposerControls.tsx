/**
 * Shared composer controls — the ONE definition of the model picker, cloud
 * toggle, and branch button used by both prompt-first surfaces (HomeView's
 * welcome composer and NewWorkspacePromptModal). Extracted so the two can't
 * drift; visual language is the welcome composer's.
 */

import { createElement, useState } from "react";
import { toast } from "sonner";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import { useCloudSettings } from "@/shared/hooks/useCloudSettings";
import { capabilities } from "@/platform/capabilities";

import { Check, ChevronDown, Cloud, GitBranch } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import {
  getModelLabel,
  getModelOption,
  MODEL_OPTIONS,
  MODEL_PICKER_GROUPS,
  type AgentHarness,
} from "@/shared/agents";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/shared/hooks/use-mobile";
import { BranchSelector } from "@/features/workspace/ui/BranchSelector";

export function AgentLogo({ type, className }: { type: AgentHarness; className?: string }) {
  const Logo = getAgentLogo(type);
  if (!Logo) {
    return <span className={cn("bg-muted-foreground/80 inline-flex rounded-full", className)} />;
  }
  return createElement(Logo, { className: cn("flex-shrink-0", className) });
}

interface ModelPickerProps {
  model: string;
  onModelChange: (value: string) => void;
}

/** Grouped model list — one markup, sized for the containing surface. */
function ModelOptionList({
  model,
  onSelect,
  size,
}: {
  model: string;
  onSelect: (value: string) => void;
  size: "sm" | "lg";
}) {
  const selected = getModelOption(model);
  const lg = size === "lg";
  return (
    <>
      {MODEL_PICKER_GROUPS.map((agentConfig, groupIdx) => (
        <div key={agentConfig.id}>
          {groupIdx > 0 && (
            <div className={cn("bg-border/70 h-px", lg ? "mx-2 my-2" : "mx-1 my-1.5")} />
          )}
          <div
            className={cn(
              "text-text-muted/90 font-normal tracking-wide",
              lg ? "px-2 py-1.5 text-xs" : "text-2xs px-2 py-1"
            )}
          >
            {agentConfig.label}
          </div>
          {MODEL_OPTIONS.filter((o) => o.agentHarness === agentConfig.id).map((option) => {
            const isSelected = selected?.value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onSelect(option.value)}
                className={cn(
                  "flex w-full items-center rounded-lg transition-colors duration-100",
                  "hover:bg-bg-raised/45",
                  lg ? "gap-2.5 px-2 py-2.5 text-sm" : "gap-2 px-2 py-1.5 text-xs",
                  isSelected ? "text-text-primary" : "text-text-secondary"
                )}
              >
                <AgentLogo type={option.agentHarness} className={lg ? "h-4 w-4" : "h-3.5 w-3.5"} />
                <span className="font-normal">{option.label}</span>
                {option.isNew && (
                  <span className="border-accent-red-muted/60 bg-accent-red-muted/20 text-accent-red-muted text-2xs rounded-xs border px-1 py-px tracking-wide uppercase">
                    New
                  </span>
                )}
                <span className="ml-auto">
                  {isSelected && (
                    <Check className={cn("text-text-primary", lg ? "size-3.5" : "size-3")} />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** Model picker trigger + surface: bottom sheet on mobile, popover on desktop. */
export function ModelPicker({ model, onModelChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const selectedOption = getModelOption(model);

  const trigger = (
    <button
      type="button"
      onClick={isMobile ? () => setOpen(true) : undefined}
      className="text-text-muted hover:text-text-secondary flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors duration-150"
    >
      <AgentLogo type={selectedOption?.agentHarness ?? "claude-code"} className="h-3 w-3" />
      <span className="font-medium">{getModelLabel(model)}</span>
      <ChevronDown
        className={cn(
          "text-text-disabled size-3 transition-transform duration-200",
          open && "rotate-180"
        )}
      />
    </button>
  );

  const select = (value: string) => {
    onModelChange(value);
    setOpen(false);
  };

  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="rounded-t-xl px-0">
            <SheetHeader className="px-4 pb-0">
              <SheetTitle className="text-sm">Select model</SheetTitle>
              <SheetDescription className="sr-only">
                Choose an AI model for your workspace
              </SheetDescription>
            </SheetHeader>
            <div className="max-h-[50vh] overflow-y-auto p-2">
              <ModelOptionList model={model} onSelect={select} size="lg" />
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(
          "w-56 overflow-hidden rounded-xl p-1.5",
          "border-border/55 from-bg-overlay/95 to-bg-elevated/94 bg-linear-to-b backdrop-blur-2xl",
          "shadow-[var(--shadow-elevated)]"
        )}
      >
        <ModelOptionList model={model} onSelect={select} size="sm" />
      </PopoverContent>
    </Popover>
  );
}

interface CloudToggleProps {
  location: "local" | "cloud";
  onLocationChange: (location: "local" | "cloud") => void;
  /** Welcome composer explains the toggle; the modal stays quiet. */
  withTooltip?: boolean;
}

/** Off-by-default cloud switch — on = the workspace runs in an agnt sandbox. */
export function CloudToggle({ location, onLocationChange, withTooltip = false }: CloudToggleProps) {
  // Signed-out truth at the moment of intent: flipping Cloud on without a
  // Deus Cloud session can only end in a failed create, so say it HERE with
  // the sign-in one click away — not as a 500 after the prompt is written.
  const cloudStatus = useCloudSettings();
  const signIn = useDeusCloudSignIn();
  const handleChange = (on: boolean) => {
    // Only select cloud once it's CONFIRMED enabled. A still-loading or errored
    // /settings/cloud leaves `data` undefined — selecting cloud then just arms a
    // submit the backend guard rejects — so treat "not confirmed enabled" as
    // unavailable and keep the switch local.
    if (on && !cloudStatus.data?.enabled) {
      // Only nudge to sign in once we KNOW it's disabled — a status that hasn't
      // loaded yet shouldn't cry "not signed in". Deus Cloud sign-in mints a
      // device credential over Electron IPC; there's no web sign-in yet, so on
      // app.deusmachine.ai point at the desktop app.
      if (cloudStatus.data && !cloudStatus.data.enabled) {
        toast("Not signed in to Deus Cloud", {
          description: capabilities.ipcInvoke
            ? "Cloud workspaces need a Deus Cloud account on this device."
            : "Sign in to Deus Cloud from the desktop app to use cloud workspaces.",
          ...(capabilities.ipcInvoke && {
            action: { label: "Sign in", onClick: () => signIn.mutate() },
          }),
        });
      }
      // Keep the location LOCAL — re-toggling after sign-in (or once the status
      // resolves to enabled) takes the cloud path below.
      return;
    }
    onLocationChange(on ? "cloud" : "local");
  };
  const label = (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors duration-150 select-none",
        location === "cloud" ? "text-text-secondary" : "text-text-disabled hover:text-text-muted"
      )}
    >
      <Cloud className="size-3 shrink-0" />
      <span>Cloud</span>
      <Switch
        checked={location === "cloud"}
        onCheckedChange={handleChange}
        className="scale-75"
        aria-label="Run on a cloud computer"
      />
    </label>
  );

  if (!withTooltip) return label;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">
          {location === "cloud"
            ? "Runs on a cloud computer (clones the repo's origin)"
            : "Off — runs in a git worktree on this Mac"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

interface BranchPickerButtonProps {
  repoId: string;
  displayBranch: string;
  onBranchSelect: (name: string) => void;
}

/** Branch selector + the composer's muted trigger button. */
export function BranchPickerButton({
  repoId,
  displayBranch,
  onBranchSelect,
}: BranchPickerButtonProps) {
  return (
    <BranchSelector repoId={repoId} currentBranch={displayBranch} onBranchSelect={onBranchSelect}>
      <button
        type="button"
        className="text-text-disabled hover:text-text-muted flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors duration-150"
      >
        <GitBranch className="size-3 shrink-0" />
        <span className="max-w-[120px] truncate">{displayBranch}</span>
        <ChevronDown className="size-2.5" />
      </button>
    </BranchSelector>
  );
}
