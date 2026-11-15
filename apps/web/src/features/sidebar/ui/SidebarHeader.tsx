import {
  Check,
  ChevronDown,
  Cloud,
  Monitor,
  PanelLeftClose,
  Settings,
  SquarePen,
} from "lucide-react";
import { SidebarHeader as SidebarHeaderUI, useSidebar } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { capabilities } from "@/platform/capabilities";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useCloudSettings } from "@/shared/hooks/useCloudSettings";
import { useComputerName } from "@/features/settings/api/auth.queries";
import { cn } from "@/shared/lib/utils";
import type { WorkspaceLocation } from "../lib/location";
import type { SidebarHeaderProps, SidebarProfile } from "../model/types";

const PLACEHOLDER_LABEL = "My Account";
const CLOUD_LABEL = "Deus Cloud";

function deriveInitials(profile: SidebarProfile | undefined): string {
  const source = profile?.displayName || profile?.login || PLACEHOLDER_LABEL;
  return source.slice(0, 2).toUpperCase();
}

function ProfileAvatar({
  profile,
  label,
  className,
}: {
  profile?: SidebarProfile;
  label: string;
  className?: string;
}) {
  return (
    <Avatar shape="square" className={cn("h-6 w-6 shrink-0 rounded-md", className)}>
      {profile?.avatarUrl && (
        <AvatarImage src={profile.avatarUrl} alt={label} className="rounded-md" />
      )}
      <AvatarFallback shape="square" className="text-2xs rounded-md font-semibold">
        {deriveInitials(profile)}
      </AvatarFallback>
    </Avatar>
  );
}

function CloudGlyph({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "bg-muted text-text-secondary flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
        className
      )}
    >
      <Cloud className="size-3.5" />
    </span>
  );
}

/**
 * SidebarHeader — where this window's workspaces run.
 *
 * The trigger names the current location (this computer, or Deus Cloud); the
 * menu switches between them (⌃1 / ⌃2), leads to the account's other
 * computers on the web, and opens Settings.
 */
export function SidebarHeader({
  profile,
  location,
  onSwitchLocation,
  onOpenSettings,
  onToggleSidebar,
  onNewSession,
  isExpanded,
}: SidebarHeaderProps) {
  const { isMobile } = useSidebar();
  const switchable = !!onSwitchLocation;
  const computerName = useComputerName(switchable).data;

  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl+";
  const toggleTitle = `${isExpanded ? "Collapse" : "Expand"} sidebar (${modKey}B)`;
  const localLabel = computerName || (capabilities.isDesktop ? "This Mac" : "This computer");
  const label = location === "cloud" ? CLOUD_LABEL : localLabel;

  return (
    <SidebarHeaderUI className="drag-region flex-row items-center justify-between gap-1 px-1.5 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${label}, switch where workspaces run`}
            className="control-interaction hover:bg-foreground/[0.04] data-[state=open]:bg-foreground/[0.04] flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 outline-none"
          >
            {location === "cloud" ? (
              <CloudGlyph />
            ) : (
              <ProfileAvatar profile={profile} label={label} />
            )}
            {isExpanded && (
              <>
                <span className="text-text-primary truncate text-sm font-medium">{label}</span>
                <ChevronDown className="text-text-muted size-3.5 shrink-0" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <AccountEmail />
          {onSwitchLocation ? (
            <LocationRows
              location={location}
              localLabel={localLabel}
              profile={profile}
              showShortcuts={isMac}
              onSwitch={onSwitchLocation}
            />
          ) : (
            <DropdownMenuItem>
              <CloudGlyph className="h-5 w-5" />
              <span className="flex-1 truncate">{CLOUD_LABEL}</span>
              <Check className="text-text-secondary" />
            </DropdownMenuItem>
          )}
          {!capabilities.isDesktop && (
            // A full page load: the relay pages and the hosted root boot different data paths.
            <DropdownMenuItem onSelect={() => window.location.assign("/connect")}>
              <Monitor />
              Your computers
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings />
            Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-0.5">
        {onNewSession && (
          <button
            type="button"
            onClick={onNewSession}
            aria-label="New session"
            title={`New session (${modKey}N)`}
            className="control-interaction text-text-muted hover:text-text-tertiary hover:bg-foreground/[0.04] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          >
            <SquarePen className="h-[16px] w-[16px]" />
          </button>
        )}

        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
          title={!isMobile ? toggleTitle : undefined}
          className={cn(
            "control-interaction text-text-muted hover:text-text-tertiary hover:bg-foreground/[0.04] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
            !isExpanded && "opacity-60"
          )}
        >
          <PanelLeftClose className="h-[18px] w-[18px]" />
        </button>
      </div>
    </SidebarHeaderUI>
  );
}

/** The Deus account's email, read only while the menu is open; nothing when signed out. */
function AccountEmail() {
  const session = useDeusCloudSession().data;
  const email = session?.signedIn ? session.accountEmail : null;
  if (!email) return null;
  return (
    <>
      <DropdownMenuLabel className="text-text-muted truncate font-normal">
        {email}
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
    </>
  );
}

/** Mounted only while the menu is open, so the cloud status is read when it is shown. */
function LocationRows({
  location,
  localLabel,
  profile,
  showShortcuts,
  onSwitch,
}: {
  location: WorkspaceLocation;
  localLabel: string;
  profile?: SidebarProfile;
  showShortcuts: boolean;
  onSwitch: (location: WorkspaceLocation) => void;
}) {
  const cloudSignedOut = useCloudSettings().data?.enabled === false;
  const rows = [
    { value: "local", label: localLabel, shortcut: "⌃1" },
    { value: "cloud", label: CLOUD_LABEL, shortcut: "⌃2" },
  ] as const;
  return rows.map((row) => (
    <DropdownMenuItem
      key={row.value}
      onSelect={() => onSwitch(row.value)}
      aria-current={row.value === location ? "true" : undefined}
    >
      {row.value === "cloud" ? (
        <CloudGlyph className="h-5 w-5" />
      ) : (
        <ProfileAvatar profile={profile} label={row.label} className="h-5 w-5" />
      )}
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.value === "cloud" && cloudSignedOut && (
        <span className="text-text-muted shrink-0 text-xs">Not signed in</span>
      )}
      {row.value === location ? (
        <Check className="text-text-secondary" />
      ) : (
        showShortcuts && (
          <DropdownMenuShortcut className="tracking-normal">{row.shortcut}</DropdownMenuShortcut>
        )
      )}
    </DropdownMenuItem>
  ));
}
