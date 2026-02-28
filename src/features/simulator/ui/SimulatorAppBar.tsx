/**
 * SimulatorAppBar — bottom strip shown when an app is running on the simulator.
 *
 * Displays the app name with a green status dot and provides quick actions:
 * relaunch, terminate, and uninstall (destructive, in overflow menu).
 */

import { Rocket, Square, Trash2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InstalledApp } from "../types";

interface SimulatorAppBarProps {
  app: InstalledApp;
  onRelaunch: () => void;
  onTerminate: () => void;
  onUninstall: () => void;
}

export function SimulatorAppBar({ app, onRelaunch, onTerminate, onUninstall }: SimulatorAppBarProps) {
  return (
    <div className="border-border-subtle flex h-8 shrink-0 items-center gap-2 border-t px-3">
      <span className="bg-success h-1.5 w-1.5 shrink-0 rounded-full" />
      <span
        className="text-text-secondary min-w-0 flex-1 truncate text-xs"
        title={app.bundle_id}
      >
        {app.name}
      </span>

      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onRelaunch} className="h-6 w-6 p-0">
              <Rocket className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Relaunch</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]">
            <DropdownMenuItem onClick={onTerminate}>
              <Square className="mr-2 h-3.5 w-3.5" />
              Terminate
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onUninstall}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Uninstall
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    </div>
  );
}
