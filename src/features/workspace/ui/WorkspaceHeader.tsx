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
import { invoke } from "@/platform/tauri";
import type { SetupStatus } from "@/shared/types";
import type { NormalizedTask } from "../api/workspace.service";
import { TaskStrip } from "./TaskStrip";
import { AppIcon, groupAppsByCategory } from "@/shared/lib/appIcons";
import {
  fixSetupErrorPrompt,
  GENERATE_HIVE_JSON,
} from "@/features/session/lib/sessionPrompts";

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
  tasks?: NormalizedTask[];
  hasManifest?: boolean;
  onRunTask?: (taskName: string) => void;
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
  tasks,
  hasManifest,
  onRunTask,
}: WorkspaceHeaderProps) {
  const { state: sidebarState, toggleSidebar } = useSidebar();
  const sidebarCollapsed = sidebarState === "collapsed";

  const subtitle = [repositoryName, branch].filter(Boolean).join(" / ");

  return (
    <div
      data-slot="workspace-header"
      className="flex h-11 flex-shrink-0 items-center justify-between px-4"
    >
      {/* Left: sidebar toggle + title + repo/branch */}
      <div className="flex min-w-0 items-center gap-[5px]">
        {sidebarCollapsed && (
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

        {title && (
          <span className="text-foreground mr-0.5 max-w-[240px] truncate text-sm font-medium">
            {title}
          </span>
        )}

        {subtitle && (
          <span
            className={cn(
              "max-w-[280px] truncate text-sm font-medium",
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
                    onClick={() =>
                      onSendAgentMessage(fixSetupErrorPrompt(setupError ?? null))
                    }
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

        {onRunTask && (
          <TaskStrip
            tasks={tasks ?? []}
            hasManifest={hasManifest ?? false}
            disabled={setupStatus === "running"}
            onRunTask={onRunTask}
            onSetupEnvironment={
              onSendAgentMessage
                ? () => onSendAgentMessage(GENERATE_HIVE_JSON)
                : undefined
            }
          />
        )}
      </div>

      {/* Right: Open button */}
      <div className="flex items-center">
        {workspacePath && <HeaderOpenButton workspacePath={workspacePath} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeaderOpenButton — open workspace in external editors with product icons
// ---------------------------------------------------------------------------

interface InstalledApp {
  id: string;
  name: string;
  path: string;
  icon?: string;
}

function HeaderOpenButton({ workspacePath }: { workspacePath: string }) {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isHoveringRef = useRef(false);

  useEffect(() => {
    invoke<InstalledApp[]>("get_installed_apps")
      .then(setApps)
      .catch(() => {});
  }, []);

  function handleOpenInApp(appId: string) {
    setOpen(false);
    invoke("open_in_app", { appId, workspacePath }).catch(() => {});
  }

  function handleCopyPath() {
    navigator.clipboard
      .writeText(workspacePath)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
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

  const trigger = (
    <button
      type="button"
      className="text-text-subtle border-border-strong hover:bg-bg-muted flex h-7 items-center gap-1 rounded-sm border px-2 transition-colors duration-200"
      onPointerEnter={apps.length > 0 ? handleOpen : undefined}
      onPointerLeave={apps.length > 0 ? handleClose : undefined}
    >
      <ArrowUpRight className="h-[11px] w-[11px]" />
      <span className="text-sm font-medium">Open</span>
      <ChevronDown className="text-text-muted h-2 w-2" />
    </button>
  );

  if (apps.length === 0) {
    return (
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Open in editor (desktop only)</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  const groups = groupAppsByCategory(apps);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
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
                {app.name}
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
