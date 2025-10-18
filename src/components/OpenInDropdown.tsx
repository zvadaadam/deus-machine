import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExternalLink, ChevronRight } from "lucide-react";

interface InstalledApp {
  id: string;
  name: string;
  path: string;
}

interface OpenInDropdownProps {
  workspacePath: string;
}

export function OpenInDropdown({ workspacePath }: OpenInDropdownProps) {
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const closeTimeoutRef = useRef<NodeJS.Timeout>();
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

  async function handleOpenInApp(appId: string) {
    try {
      await invoke("open_in_app", {
        appId,
        workspacePath,
      });
    } catch (error) {
      console.error(`Failed to open in ${appId}:`, error);
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

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 px-3 items-center"
          onPointerEnter={handleOpen}
          onPointerLeave={handleClose}
        >
          <ExternalLink className="h-4 w-4 flex-shrink-0" />
          <span className="leading-none">Open in</span>
          <ChevronRight
            className="h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-200"
            style={{
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 200ms cubic-bezier(.215, .61, .355, 1)',
            }}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={2}
        className="min-w-[140px]"
        onPointerEnter={handleOpen}
        onPointerLeave={handleClose}
      >
        {installedApps.map((app) => (
          <DropdownMenuItem
            key={app.id}
            onClick={() => handleOpenInApp(app.id)}
            className="cursor-pointer"
          >
            {app.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
