import { useState, useEffect, useRef } from "react";
import { native } from "@/platform";
import type { InstalledApp } from "@/platform";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowUpRight, ChevronRight, Check } from "lucide-react";
import { AppIcon, groupAppsByCategory } from "@/shared/lib/appIcons";
import { useLastOpenInApp } from "@/shared/hooks/useLastOpenInApp";
import { track } from "@/platform/analytics";

interface OpenInDropdownProps {
  workspacePath: string;
  iconOnly?: boolean;
}

export function OpenInDropdown({ workspacePath, iconOnly = false }: OpenInDropdownProps) {
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [lastAppId, setLastAppId] = useLastOpenInApp();
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isHoveringRef = useRef(false);

  useEffect(() => {
    async function loadInstalledApps() {
      try {
        const apps = await native.apps.getInstalled();
        setInstalledApps(apps);
      } catch {
        // May fail if the IPC handler isn't registered
      } finally {
        setLoading(false);
      }
    }

    loadInstalledApps();
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  const lastApp = lastAppId ? (installedApps.find((a) => a.id === lastAppId) ?? null) : null;

  function handleOpenInApp(appId: string) {
    setOpen(false);
    setLastAppId(appId);
    track("open_in_app", { app_id: appId });
    native.apps.openIn(appId, workspacePath).catch((error) => {
      console.error(`Failed to open in ${appId}:`, error);
    });
  }

  function handleQuickOpen() {
    if (lastApp) {
      handleOpenInApp(lastApp.id);
    } else {
      setOpen(true);
    }
  }

  function handleOpen() {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
    }
    isHoveringRef.current = true;
    setOpen(true);
  }

  function handleClose() {
    isHoveringRef.current = false;
    // Very short delay to handle rapid mouse movements
    closeTimeoutRef.current = setTimeout(() => {
      if (!isHoveringRef.current) {
        setOpen(false);
      }
    }, 50);
  }

  if (loading || installedApps.length === 0) {
    return null;
  }

  const groups = groupAppsByCategory(installedApps);

  const menuContent = (
    <DropdownMenuContent
      align="end"
      sideOffset={2}
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
              {lastApp?.id === app.id && (
                <Check className="text-muted-foreground ml-auto h-3 w-3" />
              )}
            </DropdownMenuItem>
          ))}
        </div>
      ))}
    </DropdownMenuContent>
  );

  if (iconOnly) {
    return (
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <Tooltip delayDuration={200}>
          <DropdownMenuTrigger asChild>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground/80 hover:text-foreground hover:bg-muted/10 h-9 w-9 rounded-lg transition-colors duration-200 ease-out"
                onClick={(e) => {
                  if (lastApp) {
                    e.preventDefault();
                    handleOpenInApp(lastApp.id);
                  }
                }}
              >
                {lastApp?.icon ? (
                  <img src={lastApp.icon} alt="" className="h-4 w-4 rounded-xs" draggable={false} />
                ) : (
                  <ArrowUpRight className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">
              {lastApp ? `Open in ${lastApp.name}` : "Open in\u2026"}
              <span className="text-muted-foreground ml-2">⌘O</span>
            </p>
          </TooltipContent>
        </Tooltip>
        {menuContent}
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <div className="border-border flex h-8 items-center rounded-lg border">
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleQuickOpen}
              className="text-muted-foreground/80 hover:text-foreground hover:bg-muted/10 flex h-full items-center gap-2 rounded-l-lg px-3 transition-colors duration-200"
            >
              {lastApp?.icon ? (
                <img src={lastApp.icon} alt="" className="h-4 w-4 rounded-xs" draggable={false} />
              ) : (
                <ArrowUpRight className="h-4 w-4" />
              )}
              <span className="text-sm">Open</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">
              {lastApp ? `Open in ${lastApp.name}` : "Open in\u2026"}
              <span className="text-muted-foreground ml-2">⌘O</span>
            </p>
          </TooltipContent>
        </Tooltip>

        <div className="bg-border h-4 w-px" />

        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:bg-muted/10 flex h-full items-center rounded-r-lg px-1.5 transition-colors duration-200"
            onPointerEnter={handleOpen}
            onPointerLeave={handleClose}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform duration-200 ease-out ${
                open ? "rotate-90" : ""
              }`}
            />
          </button>
        </DropdownMenuTrigger>
      </div>
      {menuContent}
    </DropdownMenu>
  );
}
