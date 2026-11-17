import { forwardRef, useState, type ComponentPropsWithoutRef } from "react";
import { match } from "ts-pattern";
import { FolderGit2, FolderPlus, Plus } from "lucide-react";
import { SidebarFooter as SidebarFooterUI } from "@/components/ui/sidebar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AIStatusIndicator } from "@/features/ai-status/ui/AIStatusIndicator";
import { ConnectionOrb } from "@/features/connection";
import { capabilities } from "@/platform/capabilities";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { GitHubIcon } from "@/shared/components/icons/GitHubIcon";
import { addProjectActions } from "@/features/repository/lib/addProject";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter — "Add project" + ambient AI provider status indicator.
 * The status indicator renders nothing when all providers are healthy.
 */
export function SidebarFooter({
  onAddRepository,
  onCloneRepository,
  onStartNewProject,
  onAddFromGitHub,
  addActions,
}: SidebarFooterProps) {
  const [open, setOpen] = useState(false);
  const actions =
    addActions ??
    addProjectActions("local", { nativeFolderPicker: capabilities.nativeFolderPicker });
  const rows = actions.map((action) => ({
    action,
    ...match(action)
      .with("start-new", () => ({
        icon: FolderGit2,
        title: "Start new project",
        hint: "Create from scratch or template",
        run: onStartNewProject,
      }))
      .with("clone", () => ({
        icon: GitHubIcon,
        title: "Clone from GitHub",
        hint: "Start from a remote repository",
        run: onCloneRepository,
      }))
      .with("open-local", () => ({
        icon: FolderPlus,
        title: "Open local project",
        hint: "Add an existing repository",
        run: onAddRepository,
      }))
      .with("add-from-github", () => ({
        icon: GitHubIcon,
        title: "Add from GitHub",
        hint: "A repository to work on in the cloud",
        run: onAddFromGitHub,
      }))
      .exhaustive(),
  }));

  return (
    <SidebarFooterUI className="flex flex-row items-center justify-between px-3.5 py-3.5">
      {/* Web-direct has nothing to add a project TO (no Mac backend) — sessions
          start from the desktop app, so the affordance doesn't render. */}
      {!isCloudDirectWebMode() &&
        (rows.length === 1 ? (
          // One way to add a project here (a cloud organization): no menu of one.
          <AddProjectButton onClick={() => rows[0].run?.()} />
        ) : (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <AddProjectButton />
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-60 p-2">
              {rows.map((row) => {
                const Icon = row.icon;
                return (
                  <button
                    key={row.action}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      row.run?.();
                    }}
                    className="control-interaction hover:bg-bg-elevated focus-visible:bg-bg-elevated flex w-full items-center gap-3 rounded-lg px-3 py-3"
                  >
                    <Icon className="text-text-muted h-4 w-4 shrink-0" />
                    <div className="min-w-0 text-left">
                      <p className="text-text-primary text-sm font-medium">{row.title}</p>
                      <p className="text-text-muted text-xs">{row.hint}</p>
                    </div>
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>
        ))}
      <div className="ml-auto flex items-center gap-2">
        <ConnectionOrb />
        <AIStatusIndicator />
      </div>
    </SidebarFooterUI>
  );
}

/** The footer's "Add project": a menu's trigger, or the one action itself. */
const AddProjectButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(
  function AddProjectButton(props, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label="Add project"
        className="text-text-muted hover:text-text-tertiary flex items-center gap-2 transition-colors duration-150"
        {...props}
      >
        <Plus className="h-4 w-4 shrink-0" />
        <span className="text-sm">Add project</span>
      </button>
    );
  }
);
