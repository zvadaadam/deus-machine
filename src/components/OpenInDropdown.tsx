import { useState, useEffect } from "react";
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

  if (loading || installedApps.length === 0) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <ExternalLink className="h-4 w-4" />
            Open in
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
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
