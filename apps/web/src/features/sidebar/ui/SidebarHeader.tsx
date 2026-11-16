import { match } from "ts-pattern";
import { Check, ChevronDown, Cloud, Monitor, PanelLeftClose, Settings } from "lucide-react";
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
import { useComputerName } from "@/features/settings/api/auth.queries";
import { cn } from "@/shared/lib/utils";
import {
  activityElsewhere,
  CLOUD_LABEL,
  organizationRowHint,
  rowSwitches,
  type PlaceActivity,
  type PlaceRow,
} from "../lib/location";
import { OrganizationTile } from "./OrganizationTile";
import type { SidebarHeaderProps, SidebarProfile } from "../model/types";

const PLACEHOLDER_LABEL = "My Account";

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
 * The trigger names the window's place (this computer, an organization, or the one
 * cloud); the menu lists each place (⌃1…⌃9), or signs in or sets up when a place
 * cannot be reached yet, leads to the account's computers on the web, and opens
 * Settings.
 */
export function SidebarHeader({
  profile,
  places,
  onOpenSettings,
  onToggleSidebar,
  isExpanded,
}: SidebarHeaderProps) {
  const { isMobile } = useSidebar();
  const withComputer = places.rows.some((row) => row.kind === "local");
  const computerName = useComputerName(withComputer).data;

  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl+";
  const toggleTitle = `${isExpanded ? "Collapse" : "Expand"} sidebar (${modKey}B)`;
  const localLabel = computerName || (capabilities.isDesktop ? "This Mac" : "This computer");
  const here = places.rows.find((row) => row.key === places.current);
  const label = here ? rowLabel(here, localLabel) : CLOUD_LABEL;
  // Work the sidebar does not list: a place other than this one has it.
  const elsewhere = activityElsewhere(places.activity, places.current);

  return (
    <SidebarHeaderUI className="drag-region flex-row items-center justify-between gap-1 px-1.5 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${label}, switch where workspaces run`}
            className="control-interaction hover:bg-foreground/[0.04] data-[state=open]:bg-foreground/[0.04] flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 outline-none"
          >
            <span className="relative flex shrink-0">
              <RowGlyph row={here} label={label} profile={profile} />
              {elsewhere && (
                <ActivityDot
                  activity={elsewhere}
                  className="ring-sidebar absolute -top-0.5 -right-0.5 ring-2"
                />
              )}
            </span>
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
          {places.rows.map((row) => (
            <PlaceItem
              key={row.key}
              row={row}
              label={rowLabel(row, localLabel)}
              current={row.key === places.current && rowSwitches(row)}
              activity={places.activity[row.key] ?? null}
              profile={profile}
              showShortcut={isMac}
              onChoose={places.onChoose}
            />
          ))}
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
    </SidebarHeaderUI>
  );
}

function rowLabel(row: PlaceRow, localLabel: string): string {
  return match(row)
    .with({ kind: "local" }, () => localLabel)
    .with({ kind: "cloud" }, () => CLOUD_LABEL)
    .with({ kind: "organization" }, (org) => org.name || CLOUD_LABEL)
    .exhaustive();
}

function RowGlyph({
  row,
  label,
  profile,
  className,
}: {
  row: PlaceRow | undefined;
  label: string;
  profile?: SidebarProfile;
  className?: string;
}) {
  if (!row || row.kind === "cloud") return <CloudGlyph className={className} />;
  if (row.kind === "organization") return <OrganizationTile name={label} className={className} />;
  return <ProfileAvatar profile={profile} label={label} className={className} />;
}

/** What a row that cannot switch yet says; choosing it does that (useWindowPlace). */
function rowHint(row: PlaceRow): string | null {
  return match(row)
    .with({ kind: "local" }, () => null)
    .with({ kind: "cloud" }, (cloud) =>
      match(cloud.state)
        .with("ready", () => null)
        .with("unavailable", () => "Not signed in")
        .with("signing-in", () => "Signing in…")
        .with("setting-up", () => "Setting up…")
        .with("retry", () => "Retry")
        .with("sign-in", () => "Sign in")
        .exhaustive()
    )
    .with({ kind: "organization" }, (org) => organizationRowHint(org.state))
    .exhaustive();
}

function PlaceItem({
  row,
  label,
  current,
  activity,
  profile,
  showShortcut,
  onChoose,
}: {
  row: PlaceRow;
  label: string;
  current: boolean;
  activity: PlaceActivity | null;
  profile?: SidebarProfile;
  showShortcut: boolean;
  onChoose: (row: PlaceRow) => void;
}) {
  const hint = rowHint(row);
  const disabled =
    (row.kind === "cloud" || row.kind === "organization") && row.state === "unavailable";
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={() => onChoose(row)}
      aria-current={current ? "true" : undefined}
    >
      <RowGlyph row={row} label={label} profile={profile} className="h-5 w-5" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {activity && <ActivityDot activity={activity} />}
      {hint ? (
        <span className="text-text-muted shrink-0 text-xs">{hint}</span>
      ) : current ? (
        <Check className="text-text-secondary" />
      ) : (
        showShortcut &&
        row.shortcut && (
          <DropdownMenuShortcut className="tracking-normal">{row.shortcut}</DropdownMenuShortcut>
        )
      )}
    </DropdownMenuItem>
  );
}

/**
 * A place's activity, in the sidebar row's colours: unread is the row's gold dot,
 * working the colour of its working indicator.
 */
function ActivityDot({ activity, className }: { activity: PlaceActivity; className?: string }) {
  return (
    <span
      data-slot="place-activity"
      data-activity={activity}
      aria-label={activity === "unread" ? "Unread reply" : "Working"}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        activity === "unread" ? "bg-accent-gold" : "bg-muted-foreground",
        className
      )}
    />
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
