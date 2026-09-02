import { useState, useEffect, useRef } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  PanelLeft,
  AlertTriangle,
  Loader2,
  RotateCw,
  ScrollText,
  Sparkles,
  Copy,
  Check,
  Cloud as CloudIcon,
  CloudOff,
  ClockFading,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/shared/lib/utils";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { native } from "@/platform";
import type { InstalledApp } from "@/platform";
import { track } from "@/platform/analytics";
import type { SetupStatus } from "@/shared/types";
import type { WorkspaceKind, WorkspaceStatus } from "@shared/enums";
import type { NormalizedTask } from "../api/workspace.service";
import { HeaderRunButton } from "./HeaderRunButton";
import { WorkflowStatusIcon } from "@/features/sidebar/ui/WorkflowStatusIcon";
import { WorkspaceStatusMenu } from "@/features/sidebar/ui/WorkspaceStatusMenu";
import { WORKFLOW_STATUS_CONFIG } from "@/features/sidebar/lib/status";
import { AppIcon, groupAppsByCategory } from "@/shared/lib/appIcons";
import { useLastOpenInApp } from "@/shared/hooks/useLastOpenInApp";
import { fixSetupErrorPrompt, GENERATE_HIVE_JSON } from "@/features/session/lib/sessionPrompts";

interface WorkspaceHeaderProps {
  title?: string;
  repositoryName?: string;
  branch?: string;
  workspacePath?: string;
  setupStatus?: SetupStatus;
  setupError?: string | null;
  onSendAgentMessage?: (text: string) => void;
  onRetrySetup?: () => void;
  onViewSetupLogs?: () => void;
  workspaceStatus?: WorkspaceStatus;
  onStatusChange?: (status: WorkspaceStatus) => void;
  tasks?: NormalizedTask[];
  hasManifest?: boolean;
  onRunTask?: (taskName: string) => void;
  /** Where the files live — 'cloud' renders the sandbox chip. */
  kind?: WorkspaceKind;
  /** Cloud only: the sandbox is paused/stopped — dim the chip, click wakes it. */
  cloudAsleep?: boolean;
  /** Cloud only: a wake is in flight — spinner chip, not clickable. */
  cloudWaking?: boolean;
  /** Cloud only: manual unpause (the chip is the wake affordance — no separate button). */
  onCloudWake?: () => void;
  /** Compact mode for mobile -- always show hamburger, hide Open button, tighter truncation */
  mobile?: boolean;
  /** Provenance: this workspace is an automation's held sandbox. */
  automationName?: string;
  /** Opens the automation's detail (run history) in the Automations view. */
  onOpenAutomation?: () => void;
}

/**
 * Workspace title header — sits at the top of the LEFT (chat) panel.
 *
 * Simple 36px bar: title + repo/branch on left, Open button on right.
 * PR actions have moved to the right panel's ContentPanelHeader.
 */
export function WorkspaceHeader({
  title,
  repositoryName,
  branch,
  workspacePath,
  setupStatus,
  setupError,
  onSendAgentMessage,
  onRetrySetup,
  onViewSetupLogs,
  workspaceStatus,
  onStatusChange,
  tasks,
  hasManifest,
  onRunTask,
  kind,
  cloudAsleep,
  cloudWaking,
  onCloudWake,
  mobile,
  automationName,
  onOpenAutomation,
}: WorkspaceHeaderProps) {
  const { state: sidebarState, toggleSidebar } = useSidebar();
  const sidebarCollapsed = sidebarState === "collapsed";
  const showSidebarToggle = sidebarCollapsed || mobile;

  const subtitle = [repositoryName, branch].filter(Boolean).join(" / ");

  return (
    <div
      data-slot="workspace-header"
      className={cn(
        "drag-region flex h-11 items-center justify-between px-4",
        mobile ? "min-w-0 gap-2" : "flex-shrink-0 gap-4"
      )}
    >
      {/* Left: sidebar toggle + title + repo/branch */}
      <div className="flex min-w-0 items-center gap-[5px] overflow-hidden">
        {showSidebarToggle && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={toggleSidebar}
                className="text-text-muted hover:text-text-secondary hover:bg-bg-muted mr-1 -ml-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg transition-colors duration-200"
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Open sidebar</p>
            </TooltipContent>
          </Tooltip>
        )}

        {workspaceStatus && onStatusChange && (
          <WorkspaceStatusMenu currentStatus={workspaceStatus} onStatusChange={onStatusChange}>
            <button
              type="button"
              className="text-text-muted hover:text-text-secondary mr-1 flex items-center gap-1 rounded-lg px-1 py-0.5 transition-colors duration-200"
            >
              <WorkflowStatusIcon status={workspaceStatus} size={14} />
            </button>
          </WorkspaceStatusMenu>
        )}

        {title && (
          <span
            className={cn(
              "text-foreground mr-0.5 min-w-0 shrink truncate text-sm font-medium",
              !mobile && "max-w-[200px]"
            )}
          >
            {title}
          </span>
        )}

        {kind === "cloud" &&
          (cloudWaking ? (
            <span className="text-text-muted border-border-secondary mr-0.5 flex flex-shrink-0 items-center gap-1 rounded-full border border-dashed px-1.5 py-px text-[11px] font-medium">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waking
            </span>
          ) : cloudAsleep ? (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                {onCloudWake ? (
                  <button
                    type="button"
                    onClick={onCloudWake}
                    className="text-text-disabled border-border-secondary hover:text-text-muted focus-visible:ring-ring mr-0.5 flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-full border border-dashed px-1.5 py-px text-[11px] font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <CloudOff className="h-3 w-3" />
                    Asleep
                  </button>
                ) : (
                  // No wake transport (web-direct): a status, not a control.
                  <span className="text-text-disabled border-border-secondary mr-0.5 flex flex-shrink-0 items-center gap-1 rounded-full border border-dashed px-1.5 py-px text-[11px] font-medium">
                    <CloudOff className="h-3 w-3" />
                    Asleep
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">
                  {onCloudWake
                    ? "Computer asleep — click to wake it, or just send a message"
                    : "Computer asleep — sending a message wakes it"}
                </p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="text-text-tertiary border-border-secondary focus-visible:ring-ring mr-0.5 flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium focus-visible:ring-2 focus-visible:outline-none"
                >
                  <CloudIcon className="h-3 w-3" />
                  Cloud
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">
                  {isCloudDirectWebMode()
                    ? "Runs on a cloud computer — files live remotely"
                    : "Runs on a cloud computer — files live remotely; the Changes tab shows the live diff"}
                </p>
              </TooltipContent>
            </Tooltip>
          ))}

        {automationName && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenAutomation}
                aria-label={`Automation: ${automationName}`}
                className="text-text-tertiary border-border-secondary hover:text-text-secondary focus-visible:ring-ring mr-0.5 flex min-w-0 flex-shrink cursor-pointer items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
              >
                <ClockFading className="h-3 w-3 shrink-0" />
                <span className="truncate">{automationName}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">
                Runs of this automation land here — click for its run history
              </p>
            </TooltipContent>
          </Tooltip>
        )}

        {subtitle && (
          <span
            className={cn(
              "min-w-0 shrink truncate text-sm font-medium",
              !mobile && "max-w-[200px]",
              title ? "text-text-subtle" : "text-foreground"
            )}
            title={subtitle}
          >
            {subtitle}
          </span>
        )}

        {setupStatus === "running" && (
          <span className="text-text-muted flex items-center gap-1 text-sm">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Installing...</span>
          </span>
        )}
        {setupStatus === "failed" && (
          <div className="flex items-center gap-1">
            <span className="text-accent-red-muted flex items-center gap-1 text-sm font-medium">
              <AlertTriangle className="h-3 w-3" />
              <span>Setup failed</span>
            </span>
            {onViewSetupLogs && (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onViewSetupLogs}
                    className="text-text-muted hover:text-text-secondary rounded-lg px-1.5 py-0.5 text-xs transition-colors duration-200"
                  >
                    <ScrollText className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">View setup logs</p>
                </TooltipContent>
              </Tooltip>
            )}
            {onSendAgentMessage && (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSendAgentMessage(fixSetupErrorPrompt(setupError ?? null))}
                    className="text-text-muted hover:text-text-secondary rounded-lg px-1.5 py-0.5 text-xs transition-colors duration-200"
                  >
                    <Sparkles className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Ask AI to fix</p>
                </TooltipContent>
              </Tooltip>
            )}
            {onRetrySetup && (
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onRetrySetup}
                    className="text-text-muted hover:text-text-secondary rounded-lg px-1.5 py-0.5 text-xs transition-colors duration-200"
                  >
                    <RotateCw className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Retry setup</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Right: Run + Open buttons (desktop only) */}
      {!mobile && (
        <div className="flex items-center gap-2">
          {onRunTask && (
            <HeaderRunButton
              tasks={tasks ?? []}
              hasManifest={hasManifest ?? false}
              disabled={setupStatus === "running"}
              onRunTask={onRunTask}
              onSetupEnvironment={
                onSendAgentMessage ? () => onSendAgentMessage(GENERATE_HIVE_JSON) : undefined
              }
            />
          )}
          {workspacePath && <HeaderOpenButton workspacePath={workspacePath} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeaderOpenButton — split button: quick open (last-used) + dropdown
// ---------------------------------------------------------------------------

function HeaderOpenButton({ workspacePath }: { workspacePath: string }) {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastAppId, setLastAppId] = useLastOpenInApp();
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isHoveringRef = useRef(false);

  useEffect(() => {
    native.apps
      .getInstalled()
      .then(setApps)
      .catch((err) => {
        console.warn("[WorkspaceHeader] Failed to fetch installed apps:", err);
      })
      .finally(() => setLoading(false));
  }, []);

  // Default app: last-used, or first editor in the list
  const lastApp = lastAppId ? (apps.find((a) => a.id === lastAppId) ?? null) : null;
  const defaultApp = lastApp ?? apps[0] ?? null;

  function handleOpenInApp(appId: string) {
    setOpen(false);
    setLastAppId(appId);
    track("open_in_app", { app_id: appId });
    native.apps.openIn(appId, workspacePath).catch((err) => {
      console.warn("[WorkspaceHeader] Failed to open in app:", err);
    });
  }

  function handleQuickOpen() {
    if (loading) return;
    if (defaultApp) {
      handleOpenInApp(defaultApp.id);
    } else {
      setOpen(true);
    }
  }

  function handleCopyPath() {
    navigator.clipboard
      .writeText(workspacePath)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((err) => {
        console.warn("[WorkspaceHeader] Failed to copy path to clipboard:", err);
      });
    setOpen(false);
  }

  function handleOpen() {
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    isHoveringRef.current = true;
    setOpen(true);
  }

  function handleClose() {
    isHoveringRef.current = false;
    closeTimeoutRef.current = setTimeout(() => {
      if (!isHoveringRef.current) setOpen(false);
    }, 50);
  }

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    };
  }, []);

  // Hide only after loading confirms no apps installed (web mode)
  if (!loading && apps.length === 0) {
    return null;
  }

  const groups = groupAppsByCategory(apps);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <div className="border-border-strong flex h-7 shrink-0 items-center rounded-lg border">
        {/* Left: quick-open action */}
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleQuickOpen}
              className="text-text-subtle hover:bg-bg-muted flex h-full shrink-0 items-center gap-1.5 rounded-l-lg px-2 transition-colors duration-200"
            >
              {defaultApp?.icon ? (
                <img
                  src={defaultApp.icon}
                  alt=""
                  className="h-4 w-4 shrink-0 rounded-xs"
                  draggable={false}
                />
              ) : (
                <ArrowUpRight className="h-[11px] w-[11px] shrink-0" />
              )}
              <span className="shrink-0 text-sm font-medium">Open</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">
              {defaultApp ? `Open in ${defaultApp.name}` : "Open in\u2026"}
              <span className="text-text-muted ml-2">⌘O</span>
            </p>
          </TooltipContent>
        </Tooltip>

        {/* Divider */}
        <div className="bg-border-strong h-4 w-px shrink-0" />

        {/* Right: dropdown chevron */}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Choose app to open in"
            className="text-text-muted hover:bg-bg-muted hover:text-text-subtle flex h-full shrink-0 items-center rounded-r-lg px-1.5 transition-colors duration-200"
            onPointerEnter={handleOpen}
            onPointerLeave={handleClose}
          >
            <ChevronDown className="h-2.5 w-2.5" />
          </button>
        </DropdownMenuTrigger>
      </div>

      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="min-w-[140px] shadow-sm"
        onPointerEnter={handleOpen}
        onPointerLeave={handleClose}
      >
        {groups.map((group, groupIdx) => (
          <div key={group.category}>
            {groupIdx > 0 && <DropdownMenuSeparator />}
            {group.apps.map((app) => (
              <DropdownMenuItem
                key={app.id}
                onClick={() => handleOpenInApp(app.id)}
                className="cursor-pointer gap-2 py-1 text-xs"
              >
                {app.icon ? (
                  <img
                    src={app.icon}
                    alt=""
                    className="h-5 w-5 flex-shrink-0 rounded-xs"
                    draggable={false}
                  />
                ) : (
                  <AppIcon appId={app.id} className="h-5 w-5 flex-shrink-0" />
                )}
                <span className={lastApp?.id === app.id ? "font-medium" : ""}>{app.name}</span>
                {lastApp?.id === app.id && <Check className="text-text-muted ml-auto h-3 w-3" />}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleCopyPath}
          className="text-text-muted cursor-pointer gap-2 py-1 text-xs"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Copy className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          {copied ? "Copied!" : "Copy path"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
