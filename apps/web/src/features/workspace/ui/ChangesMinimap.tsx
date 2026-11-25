/**
 * ChangesMinimap — Collapsed file tree that shows one colored line per changed file.
 *
 * Default state: thin vertical strip (~24px) on the right edge of the diff viewer.
 * On hover: a floating panel slides in showing the full ChangesFilesPanel.
 *
 * Clicking a line scrolls the diff viewer to that file.
 *
 * The hover panel is rendered via Portal to escape ancestor overflow-hidden containers.
 * Hover-intent pattern: shared timeout between strip and panel prevents flicker.
 */

import { tempo } from "@/shared/lib/tempo";
import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";
import { PinIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { fileChangeLabel, STATUS_BG } from "../lib/workspace.utils";
import { ChangesFilesPanel } from "./ChangesFilesPanel";
import type { FileChange } from "@/shared/types";

interface ChangesMinimapProps {
  fileChanges: FileChange[];
  selectedFile: string | null;
  onFileClick: (path: string) => void;
  /** Called when the user pins the hover panel open (switches to expanded mode) */
  onPin: () => void;
}

const HOVER_ENTER_DELAY = 150;
const HOVER_LEAVE_DELAY = 200;

export function ChangesMinimap({
  fileChanges,
  selectedFile,
  onFileClick,
  onPin,
}: ChangesMinimapProps) {
  const [showPanel, setShowPanel] = useState(false);
  const showPanelRef = useRef(false);
  const leaveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const enterTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const stripRef = useRef<HTMLDivElement>(null);

  const [panelRect, setPanelRect] = useState({ top: 0, right: 0, height: 0 });

  useEffect(() => {
    showPanelRef.current = showPanel;
  });

  useEffect(() => {
    return () => {
      clearTimeout(leaveTimeoutRef.current);
      clearTimeout(enterTimeoutRef.current);
    };
  }, []);

  // Anchor panel position to strip's left edge
  useEffect(() => {
    if (!showPanel || !stripRef.current) return;
    const rect = stripRef.current.getBoundingClientRect();
    setPanelRect({
      top: rect.top,
      right: window.innerWidth - rect.left,
      height: rect.height,
    });
  }, [showPanel]);

  // Hover-intent: shared timeouts between strip and panel prevent flicker
  const handleMouseEnter = useCallback(() => {
    clearTimeout(leaveTimeoutRef.current);
    if (!showPanelRef.current) {
      enterTimeoutRef.current = setTimeout(() => setShowPanel(true), HOVER_ENTER_DELAY);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    clearTimeout(enterTimeoutRef.current);
    leaveTimeoutRef.current = setTimeout(() => setShowPanel(false), HOVER_LEAVE_DELAY);
  }, []);

  const handleFileClickAndPin = useCallback(
    (path: string) => {
      onFileClick(path);
      onPin();
    },
    [onFileClick, onPin]
  );

  return (
    <div className="flex h-full flex-shrink-0">
      {/* Strip — thin column of colored lines */}
      <div
        ref={stripRef}
        className="border-border/30 flex w-6 flex-col items-center gap-[3px] border-l py-3"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {fileChanges.map((change) => (
          <button
            key={change.file}
            type="button"
            onClick={() => handleFileClickAndPin(change.file)}
            className={cn(
              "h-[2px] flex-shrink-0 rounded-full transition-opacity",
              STATUS_BG[change.status],
              selectedFile === change.file ? "w-3.5 opacity-100" : "w-2.5 opacity-60"
            )}
            aria-label={fileChangeLabel(change)}
          />
        ))}
      </div>

      {/* Floating panel — rendered in a Portal to escape overflow-hidden ancestors */}
      {createPortal(
        <AnimatePresence>
          {showPanel && (
            <m.div
              initial={{ opacity: 0, x: 4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 4, transition: tempo.moderate.exit }}
              transition={tempo.moderate}
              style={{
                position: "fixed",
                top: panelRect.top,
                right: panelRect.right,
                height: panelRect.height,
              }}
              className="border-border/40 bg-background z-50 flex w-60 flex-col rounded-l-lg border shadow-lg"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              {/* Header */}
              <div className="border-border/30 flex h-8 flex-shrink-0 items-center justify-between border-b px-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-text-muted text-xs">Files</span>
                  <span className="text-text-muted/60 text-[10px] tabular-nums">
                    {fileChanges.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onPin}
                  className="control-interaction text-text-muted hover:text-text-secondary hover:bg-control-hover active:bg-control-pressed flex h-5 w-5 items-center justify-center rounded-lg"
                  title="Pin file tree open"
                >
                  <PinIcon className="h-3 w-3" />
                </button>
              </div>

              {/* File tree — reused as-is */}
              <div className="min-h-0 flex-1 overflow-hidden">
                <ChangesFilesPanel
                  fileChanges={fileChanges}
                  selectedFile={selectedFile}
                  onFileClick={onFileClick}
                />
              </div>
            </m.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
