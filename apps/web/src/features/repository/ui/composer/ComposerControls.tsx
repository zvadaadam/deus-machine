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
import { useCloudAccessGate } from "./useCloudAccessGate";
import { GrantRepositoryAccessModal } from "./GrantRepositoryAccessModal";

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
  /** Selected repo — cloud is gated on the GitHub App covering it (private repos). */
  repoId?: string | null;
  /** Welcome composer explains the toggle; the modal stays quiet. */
  withTooltip?: boolean;
}

/** Off-by-default cloud switch — on = the workspace runs in an agnt sandbox. */
export function CloudToggle({
  location,
  onLocationChange,
  repoId,
  withTooltip = false,
}: CloudToggleProps) {
  const cloudStatus = useCloudSettings();
  const signIn = useDeusCloudSignIn();
  const signedIn = !!cloudStatus.data?.enabled;

  // The cloud-access gate (access probe + Grant modal + auto-continue) lives in
  // its own hook so this stays a toggle — see useCloudAccessGate.
  const gate = useCloudAccessGate({ repoId, signedIn, location, onLocationChange });

  const handleChange = (on: boolean) => {
    // Signed-out truth at the moment of intent: flipping Cloud on without a Deus
    // Cloud session can only end in a failed create, so say it HERE with the
    // sign-in one click away — not as a 500 after the prompt is written. Only
    // nudge once we KNOW it's disabled (data loaded); a still-loading status
    // shouldn't cry "not signed in".
    if (on && !signedIn) {
      if (cloudStatus.data) {
        toast("Not signed in to Deus Cloud", {
          description: capabilities.ipcInvoke
            ? "Cloud workspaces need a Deus Cloud account on this device."
            : "Sign in to Deus Cloud from the desktop app to use cloud workspaces.",
          ...(capabilities.ipcInvoke && {
            action: { label: "Sign in", onClick: () => signIn.mutate() },
          }),
        });
      }
      return;
    }
    // Second truth at the moment of intent: a private repo the sandbox can't
    // clone. The gate raises the Grant modal and keeps us local until granted.
    if (gate.interceptCloud(on)) return;
    onLocationChange(on ? "cloud" : "local");
  };
  // The switch reflects the user's INTENT immediately (on during a pending
  // access check) even though `location` only commits to cloud once the verdict
  // resolves — so a toggle click always registers visually.
  const cloudActive = location === "cloud" || gate.pending;
  const label = (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors duration-150 select-none",
        cloudActive ? "text-text-secondary" : "text-text-disabled hover:text-text-muted"
      )}
    >
      <Cloud className="size-3 shrink-0" />
      <span>Cloud</span>
      <Switch
        checked={cloudActive}
        onCheckedChange={handleChange}
        className="scale-75"
        aria-label="Run on a cloud computer"
      />
    </label>
  );

  const control = !withTooltip ? (
    label
  ) : (
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

  return (
    <>
      {control}
      <GrantRepositoryAccessModal
        open={gate.grantOpen}
        onOpenChange={gate.onOpenChange}
        slug={gate.slug}
      />
    </>
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
