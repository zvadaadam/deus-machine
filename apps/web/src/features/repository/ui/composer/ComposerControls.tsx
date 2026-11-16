/**
 * The Home composer's controls for where a new workspace runs: the cloud
 * toggle and the branch button. Its model picker is the chat composer's own
 * (features/session ModelPicker), fed by useNewChatSelection.
 */

import { toast } from "sonner";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { capabilities } from "@/platform/capabilities";
import { retryProvision } from "@/platform/native/deus-cloud";
import {
  organizationRowHint,
  organizationRowState,
  type OrganizationRowState,
} from "@/features/sidebar/lib/location";
import { retryCloudSetup, useSidebarStore } from "@/features/sidebar/store/sidebarStore";
import { OrganizationTile } from "@/features/sidebar/ui/OrganizationTile";
import { chooseComposerOrganization, cloudControlWords } from "../../lib/cloudControl";
import { useCloudAccessGate } from "./useCloudAccessGate";
import { GrantRepositoryAccessModal } from "./GrantRepositoryAccessModal";

import { Check, ChevronDown, Cloud, GitBranch } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BranchSelector } from "@/features/workspace/ui/BranchSelector";

type Organization = { id: string; name: string; ready: boolean };

interface CloudToggleProps {
  location: "local" | "cloud";
  onLocationChange: (location: "local" | "cloud") => void;
  /** Selected repo — cloud is gated on the GitHub App covering it (private repos). */
  repoId?: string | null;
  /** The composer's organization (a cloud workspace starts there); null with no list. */
  organization: Organization | null;
  /** The account's organizations, in the list's order; with more than one the label
   *  is a menu of them. */
  organizations?: Organization[];
  /** Make one the composer's organization (the composer's own; the sidebar stays). */
  onOrganizationChange?: (id: string) => void;
  /** The cloud can be chosen: that organization is ready (or, with no list, the
   *  cloud is available); undefined until known. */
  cloudReady: boolean | undefined;
  /** Welcome composer explains the toggle; the modal stays quiet. */
  withTooltip?: boolean;
  /**
   * The project can only run in the cloud: the switch shows `location` and cannot
   * be turned, and this is its tooltip ("<name> is not on this Mac").
   */
  lockedReason?: string | null;
}

/**
 * Off-by-default cloud switch — on = the workspace runs on a cloud computer. With
 * several organizations the glyph and label open a menu of them; choosing one turns
 * the cloud on there.
 */
export function CloudToggle({
  location,
  onLocationChange,
  repoId,
  organization,
  organizations = [],
  onOrganizationChange,
  cloudReady,
  withTooltip = false,
  lockedReason = null,
}: CloudToggleProps) {
  const signIn = useDeusCloudSignIn();
  const signedIn = cloudReady === true;
  const several = organizations.length > 1;
  const words = cloudControlWords({
    several,
    location,
    organizationName: organization?.name ?? null,
    lockedReason,
  });

  // The cloud-access gate (access probe + Grant modal + auto-continue) lives in
  // its own hook so this stays a toggle — see useCloudAccessGate. It asks for the
  // organization the workspace would start in.
  const gate = useCloudAccessGate({
    repoId,
    organizationId: organization?.id ?? null,
    signedIn,
    location,
    onLocationChange,
  });

  const handleChange = (on: boolean) => {
    if (lockedReason) return;
    // The truth at the moment of intent: flipping Cloud on where it cannot run can only
    // end in a failed create, so say it HERE with the way out one click away — not as
    // a 500 after the prompt is written. Only once we KNOW (the value arrived).
    if (on && !signedIn) {
      if (cloudReady === false && organization) {
        toast(`${organization.name} is not set up on this computer`, {
          description: capabilities.ipcInvoke
            ? "Set up its cloud access to start workspaces there."
            : "Set it up from the desktop app to start cloud workspaces there.",
          ...(capabilities.ipcInvoke && {
            action: { label: "Set up", onClick: () => void retryProvision() },
          }),
        });
      } else if (cloudReady === false) {
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
  const tone =
    location === "cloud" ? "text-text-secondary" : "text-text-disabled hover:text-text-muted";
  const toggle = (
    <Switch
      checked={location === "cloud"}
      onCheckedChange={handleChange}
      disabled={!!lockedReason}
      className="shrink-0 scale-75"
      aria-label={words.switchName}
    />
  );
  // The tooltip says where it runs. With the chooser it is the switch's only, so it never
  // covers the open organization menu.
  const explained = (trigger: React.ReactElement) =>
    !withTooltip && !lockedReason ? (
      trigger
    ) : (
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{words.tooltip}</p>
        </TooltipContent>
      </Tooltip>
    );

  const control = words.chooser ? (
    <div className="flex min-w-0 items-center rounded-lg text-sm select-none">
      <OrganizationMenu
        label={words.label}
        className={tone}
        location={location}
        organization={organization}
        organizations={organizations}
        setOrganization={(id) => onOrganizationChange?.(id)}
        requestCloud={gate.requestCloud}
      />
      {explained(<span className="flex items-center pr-2">{toggle}</span>)}
    </div>
  ) : (
    explained(
      <label
        className={cn(
          "control-interaction flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm select-none",
          tone
        )}
      >
        <Cloud className="size-3 shrink-0" />
        <span className="max-w-40 truncate">{words.label}</span>
        {toggle}
      </label>
    )
  );

  return (
    <>
      {control}
      <GrantRepositoryAccessModal
        open={gate.grantOpen}
        onOpenChange={gate.onOpenChange}
        slug={gate.slug}
        organizationId={organization?.id ?? null}
      />
    </>
  );
}

/**
 * The organizations, as the header menu lists them: each one's tile and name, the
 * check on the one in use while the cloud is on, and the same words and setup for one
 * not set up on this computer. Its Set up leaves the window where it is; once that
 * organization is ready the composer chooses it.
 */
function OrganizationMenu({
  label,
  className,
  location,
  organization,
  organizations,
  setOrganization,
  requestCloud,
}: {
  label: string;
  className: string;
  location: "local" | "cloud";
  organization: Organization | null;
  organizations: Organization[];
  /** Make the organization the composer's. */
  setOrganization: (id: string) => void;
  /** Go into the cloud there, through the access gate. */
  requestCloud: (id: string) => void;
}) {
  const session = useDeusCloudSession().data;
  const retrying = useSidebarStore((s) => s.cloudSetupRetrying);
  const canSetUp = capabilities.deusCloudSignIn;
  const rowState = (org: Organization): OrganizationRowState =>
    organizationRowState({ ready: org.ready, session, retrying, canSetUp });

  // A Set up started here: once it is made, the organization is the composer's and the
  // cloud is asked for there; the gate holds it until the pushed list says it is ready.
  const setUp = (id: string) => {
    void retryCloudSetup(retryProvision, id, { moveWindow: false }).then((result) => {
      if (!result.ok) {
        toast.error(result.error ?? "Cloud setup failed");
        return;
      }
      setOrganization(id);
      requestCloud(id);
    });
  };
  const actions = { setOrganization, requestCloud, setUp };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Choose the cloud organization"
          className={cn(
            "control-interaction flex min-w-0 items-center gap-1.5 rounded-lg py-1.5 pr-1 pl-2 outline-none",
            className
          )}
        >
          <Cloud className="size-3 shrink-0" />
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDown className="size-2.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {organizations.map((org) => {
          const state = rowState(org);
          const hint = organizationRowHint(state);
          const current = location === "cloud" && org.id === organization?.id;
          return (
            <DropdownMenuItem
              key={org.id}
              disabled={state === "unavailable"}
              aria-current={current ? "true" : undefined}
              onSelect={() => chooseComposerOrganization({ id: org.id, state }, actions)}
            >
              <OrganizationTile name={org.name} className="h-5 w-5" />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {hint ? (
                <span className="text-text-muted shrink-0 text-xs">{hint}</span>
              ) : (
                current && <Check className="text-text-secondary" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface BranchPickerButtonProps {
  repoId: string;
  /** The organization whose GitHub access lists a project with no folder here. */
  organizationId?: string | null;
  displayBranch: string;
  onBranchSelect: (name: string) => void;
}

/** Branch selector + the composer's muted trigger button. */
export function BranchPickerButton({
  repoId,
  organizationId,
  displayBranch,
  onBranchSelect,
}: BranchPickerButtonProps) {
  return (
    <BranchSelector
      repoId={repoId}
      organizationId={organizationId}
      currentBranch={displayBranch}
      onBranchSelect={onBranchSelect}
    >
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
