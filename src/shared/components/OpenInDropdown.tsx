import { useState, useEffect, useRef } from "react";
import { invoke } from "@/platform/tauri";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { AppIcon, groupAppsByCategory } from "@/shared/lib/appIcons";

interface InstalledApp {
  id: string;
  name: string;
  path: string;
  icon?: string;
}

interface OpenInDropdownProps {
  workspacePath: string;
  iconOnly?: boolean;
}

export function OpenInDropdown({ workspacePath, iconOnly = false }: OpenInDropdownProps) {
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isHoveringRef = useRef(false);

  useEffect(() => {
    async function loadInstalledApps() {
      try {
        const apps = await invoke<InstalledApp[]>("get_installed_apps");
        setInstalledApps(apps);
      } catch (error) {
        console.error("Failed to load installed apps:", error);
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

  function handleOpenInApp(appId: string) {
    setOpen(false);
    invoke("open_in_app", {
      appId,
      workspacePath,
    }).catch((error) => {
      console.error(`Failed to open in ${appId}:`, error);
    });
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

  const triggerButton = (
    <Button
      variant={iconOnly ? "ghost" : "outline"}
      size={iconOnly ? "icon" : "sm"}
      className={
        iconOnly
          ? "text-muted-foreground/80 hover:text-foreground hover:bg-muted/10 h-9 w-9 rounded-lg transition-colors duration-200 ease-out"
          : "gap-2 px-3"
      }
      onPointerEnter={handleOpen}
      onPointerLeave={handleClose}
    >
      <ArrowUpRight className="h-4 w-4" />
      {!iconOnly && (
        <>
          <span className="text-sm">Open in</span>
          <ChevronRight
            className={`text-muted-foreground h-4 w-4 transition-transform duration-200 ease-out ${
              open ? "rotate-90" : "rotate-0"
            }`}
          />
        </>
      )}
    </Button>
  );

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
              {app.name}
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
            <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
          </DropdownMenuTrigger>
          <TooltipContent side="bottom">
            <p className="text-xs">Open in Finder, VSCode, Cursor...</p>
          </TooltipContent>
        </Tooltip>
        {menuContent}
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      {menuContent}
    </DropdownMenu>
  );
}
