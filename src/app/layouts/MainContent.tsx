/**
 * Main Content — layout orchestrator.
 *
 * Renders ChatArea (left) + resize handle + RightSidePanel (right).
 * Owns only layout-level concerns: resize handle, chatAreaRef bridge
 * for opening diff/file tabs, and createPRHandler bridge.
 *
 * Resize handle only active when browser tab expands the right panel.
 * Diffs/files open as tabs in ChatArea (VS Code pattern).
 */

import { useState, useRef } from "react";
import type { SessionPanelRef } from "@/features/session";
import { WelcomeView } from "@/features/repository";
import { useWorkspaceLayout, useResizeHandle } from "@/features/workspace";
import { SidebarInset, useSidebar } from "@/components/ui";
import { PanelLeft } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { Workspace, PRStatus } from "@/shared/types";
import { ChatArea } from "./ChatArea";
import type { ChatAreaRef } from "./ChatArea";
import { RightSidePanel } from "./RightSidePanel";

interface MainContentProps {
  selectedWorkspace: Workspace | null;
  prStatus: PRStatus | null;
  workspaceChatPanelRef: React.MutableRefObject<SessionPanelRef | null>;
  onCreateWorkspace: () => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
}

export function MainContent({
  selectedWorkspace,
  prStatus,
  workspaceChatPanelRef,
  onCreateWorkspace,
  onOpenProject,
  onCloneRepository,
}: MainContentProps) {
  const { open: sidebarOpen, toggleSidebar } = useSidebar();

  // Layout state — only what MainContent needs for orchestration
  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const { rightPanelWidth, setRightPanelWidth } = useWorkspaceLayout(selectedWorkspaceId);

  // PR handler bridge: ChatArea sets it, RightSidePanel consumes it
  const [createPRHandler, setCreatePRHandler] = useState<(() => void) | null>(null);

  // Right side expansion state (only true for browser tab)
  const [rightSideExpanded, setRightSideExpanded] = useState(false);

  // ChatArea ref — for opening diff/file tabs from RightSidePanel
  const chatAreaRef = useRef<ChatAreaRef>(null);

  // Resize handle for chat/right-side split (only active in browser mode)
  const { handleProps: resizeHandleProps, isDragging } = useResizeHandle({
    onWidthChange: setRightPanelWidth,
    enabled: rightSideExpanded,
  });

  // Right side width: user-set pixels (browser mode) or auto
  const rightSideStyle: React.CSSProperties | undefined =
    rightSideExpanded && rightPanelWidth !== null
      ? { width: rightPanelWidth, flexShrink: 0 }
      : undefined;

  return (
    <SidebarInset className="min-w-0">
      <div
        data-slot="main-content"
        className="bg-background border-border/5 flex h-full min-w-0 flex-1 overflow-hidden rounded-lg border"
      >
        {/* Sidebar toggle — visible when sidebar collapsed and no workspace tab bar */}
        {!sidebarOpen && !selectedWorkspace && (
          <button
            type="button"
            aria-label="Expand sidebar"
            onClick={toggleSidebar}
            className="text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5 absolute top-3 left-3 z-10 flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-200 ease-out"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        <div className="flex min-w-0 flex-1">
          {selectedWorkspace ? (
            <>
              {/* Chat panel — also renders diff/file tabs */}
              <ChatArea
                ref={chatAreaRef}
                workspace={selectedWorkspace}
                workspaceChatPanelRef={workspaceChatPanelRef}
                onCreatePRHandlerChange={setCreatePRHandler}
              />

              {/* Resize handle — only between chat and expanded browser panel */}
              {rightSideExpanded && (
                <div
                  {...resizeHandleProps}
                  className="group relative z-10 flex w-0 flex-shrink-0 cursor-col-resize items-center justify-center"
                  aria-label="Resize panels"
                  role="separator"
                  aria-orientation="vertical"
                >
                  <div className="absolute inset-y-0 w-3 -translate-x-1/2" />
                  <div
                    className={cn(
                      "absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full transition-opacity duration-200 ease-[ease]",
                      isDragging
                        ? "bg-primary/40 opacity-100"
                        : "bg-border opacity-0 group-hover:opacity-100"
                    )}
                  />
                </div>
              )}

              {/* Right side panel — file tree + sidecar tabs */}
              <RightSidePanel
                workspace={selectedWorkspace}
                prStatus={prStatus}
                createPRHandler={createPRHandler}
                onExpandedChange={setRightSideExpanded}
                rightPanelWidth={rightPanelWidth}
                rightSideStyle={rightSideStyle}
                onOpenDiffTab={(path) => chatAreaRef.current?.openDiffTab(path)}
                onOpenFileTab={(path) => chatAreaRef.current?.openFileTab(path)}
              />
            </>
          ) : (
            <WelcomeView
              onCreateWorkspace={onCreateWorkspace}
              onOpenProject={onOpenProject}
              onCloneRepository={onCloneRepository}
            />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
