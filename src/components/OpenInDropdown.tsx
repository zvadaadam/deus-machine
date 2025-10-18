import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExternalLink } from "lucide-react";

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
    // Cleanup timeout on unmount
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

  function handleMouseEnter() {
    // Clear any pending close timeout
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
    }
    setOpen(true);
  }

  function handleMouseLeave() {
    // Add a small delay before closing to prevent flickering
    closeTimeoutRef.current = setTimeout(() => {
      setOpen(false);
    }, 150);
  }

  if (loading || installedApps.length === 0) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <ExternalLink className="h-4 w-4" />
            Open in
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {installedApps.map((app) => (
            <DropdownMenuItem
              key={app.id}
              onClick={() => handleOpenInApp(app.id)}
            >
              {app.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  );
}
