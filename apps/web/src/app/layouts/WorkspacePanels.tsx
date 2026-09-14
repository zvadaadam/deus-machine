import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { webviewManager } from "@/features/browser/webview-manager";
import type { WorkspacePanelMode } from "@/features/workspace/store/workspaceLayoutStore";
import { cn } from "@/shared/lib/utils";

interface WorkspacePanelsProps {
  workspaceId: string;
  mode: WorkspacePanelMode;
  onModeChange: (mode: WorkspacePanelMode) => void;
  chat: ReactNode;
  content?: ReactNode;
}

/** The panes stay mounted in all three views: hiding a tool must not destroy its session. */
export function WorkspacePanels({
  workspaceId,
  mode,
  onModeChange,
  chat,
  content,
}: WorkspacePanelsProps) {
  const groupRef = useRef<ImperativePanelGroupHandle>(null);
  // One in-memory split width, shared across workspaces. No saved sizes or layout history.
  const splitWidth = useRef(50);
  const applyingMode = useRef(false);
  const hasContent = content != null;
  const view = hasContent ? mode : "chat";

  useLayoutEffect(() => {
    applyingMode.current = true;
    groupRef.current?.setLayout(
      !hasContent
        ? [100]
        : view === "chat"
          ? [100, 0]
          : view === "content"
            ? [0, 100]
            : [splitWidth.current, 100 - splitWidth.current]
    );
    applyingMode.current = false;
  }, [workspaceId, view, hasContent]);

  const handleLayout = useCallback(
    (sizes: number[]) => {
      if (sizes.length !== 2 || applyingMode.current) return;
      const [chatSize, contentSize] = sizes;
      if (chatSize > 0 && contentSize > 0) splitWidth.current = chatSize;
      // Dragging or keyboard-resizing to an edge uses the same state as the buttons.
      const nextMode = chatSize === 0 ? "content" : contentSize === 0 ? "chat" : "split";
      if (nextMode !== view) onModeChange(nextMode);
    },
    [view, onModeChange]
  );

  useEffect(() => () => webviewManager.setPointerEventsEnabled(true), []);

  return (
    <ResizablePanelGroup
      ref={groupRef}
      direction="horizontal"
      onLayout={handleLayout}
      data-workspace-view={view}
    >
      <ResizablePanel
        id="workspace-chat"
        order={1}
        defaultSize={view === "content" ? 0 : view === "chat" ? 100 : 50}
        minSize={20}
        collapsible={hasContent}
        collapsedSize={0}
      >
        <div
          data-slot="workspace-chat-pane"
          aria-hidden={view === "content"}
          {...(view === "content" ? { inert: "" } : {})}
          className={cn("flex h-full min-w-0 flex-col", view === "content" && "invisible")}
        >
          {chat}
        </div>
      </ResizablePanel>
      {hasContent && (
        <>
          <ResizableHandle
            disabled={view !== "split"}
            className={cn(view !== "split" && "hidden")}
            onDragging={(dragging) => webviewManager.setPointerEventsEnabled(!dragging)}
          />
          <ResizablePanel
            id="workspace-content"
            order={2}
            defaultSize={view === "chat" ? 0 : view === "content" ? 100 : 50}
            minSize={20}
            collapsible
            collapsedSize={0}
          >
            <div
              data-slot="workspace-content-pane"
              aria-hidden={view === "chat"}
              {...(view === "chat" ? { inert: "" } : {})}
              className={cn("flex h-full min-w-0 flex-col", view === "chat" && "invisible")}
            >
              {content}
            </div>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
