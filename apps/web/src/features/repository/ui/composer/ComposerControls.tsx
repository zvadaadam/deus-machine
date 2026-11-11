/**
 * Shared composer controls — the ONE definition of the cloud toggle and branch
 * button used by both prompt-first surfaces (HomeView's welcome composer and
 * NewWorkspacePromptModal). Extracted so the two can't drift; visual language
 * is the welcome composer's. Their model picker is the chat composer's own
 * (features/session ModelPicker), fed by useNewChatSelection.
 */

import { toast } from "sonner";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import { useCloudSettings } from "@/shared/hooks/useCloudSettings";
import { capabilities } from "@/platform/capabilities";
import { useCloudAccessGate } from "./useCloudAccessGate";
import { GrantRepositoryAccessModal } from "./GrantRepositoryAccessModal";

import { ChevronDown, Cloud, GitBranch } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BranchSelector } from "@/features/workspace/ui/BranchSelector";

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
  // The switch reflects the COMMITTED location — cloud only once the gate has a
  // confirmed verdict. A still-resolving intent stays visually off (local), so
  // the switch and what a submit would create never disagree.
  const label = (
    <label
      className={cn(
        "control-interaction flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm select-none",
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
        className="control-interaction text-text-disabled hover:text-text-muted flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm"
      >
        <GitBranch className="size-3 shrink-0" />
        <span className="max-w-[120px] truncate">{displayBranch}</span>
        <ChevronDown className="size-2.5" />
      </button>
    </BranchSelector>
  );
}
