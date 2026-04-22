/**
 * FocusModeOverlay — Codex-style chat composer that floats over the browser.
 *
 * Portaled to document.body above the webview's root fixed stacking
 * context (WEBVIEW_OVERLAY_Z). Anchored to the browser panel's bounding
 * rect so it visually sits over the browser pane while living outside
 * its component tree.
 *
 * Renders a `<SessionComposer>` pinned to the active chat session of the
 * workspace. Composer state (draft, model, thinking level, plan mode)
 * lives in `sessionComposerStore` keyed by sessionId, so the overlay and
 * the main chat panel see identical state in real time — switch models
 * here, the chat picks it up on remount; keep typing mid-draft, the
 * draft follows.
 */
/* eslint-env browser */

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SessionComposer } from "@/features/session/ui/SessionComposer";
import { useWorkspaceLayoutStore } from "@/features/workspace/store/workspaceLayoutStore";
import { WEBVIEW_OVERLAY_Z } from "../webview-manager";

interface FocusModeOverlayProps {
  /** Browser panel container — used to anchor the overlay over it. */
  anchorEl: HTMLElement | null;
  workspaceId: string;
  onExit: () => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function readRect(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function FocusModeOverlay({ anchorEl, workspaceId, onExit }: FocusModeOverlayProps) {
  const [rect, setRect] = useState<Rect | null>(anchorEl ? readRect(anchorEl) : null);

  // Active chat session for this workspace — shares composer state with
  // the main chat panel via sessionComposerStore.
  const activeSessionId = useWorkspaceLayoutStore(
    (s) => s.layouts[workspaceId]?.activeChatTabSessionId ?? null
  );

  // Track the anchor's bounds — stays in sync with splitter drags +
  // window resize via ResizeObserver + scroll/resize listeners. All state
  // updates happen inside RO / rAF / event callbacks, so the effect body
  // itself never calls setState synchronously.
  useLayoutEffect(() => {
    if (!anchorEl) {
      // React to anchor being detached — legitimate dependency-sync case
      // where the rule's normal "update in callback" advice doesn't apply.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRect(null);
      return;
    }
    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setRect(readRect(anchorEl));
      });
    };
    // ResizeObserver fires synchronously on observe() with the current
    // size — which drives the initial `setRect` through `schedule` →
    // rAF. No explicit initial setState needed.
    const ro = new ResizeObserver(schedule);
    ro.observe(anchorEl);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [anchorEl]);

  // Esc exits focus mode (BrowserPanel has its own listener too; this
  // keeps the overlay self-contained when reused elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  if (!rect) return null;

  // Three concentric layers, each with exactly one job:
  //   1. Anchor (position: fixed) — align to the browser panel's rect, sit
  //      above the webview (zIndex) while letting clicks fall through
  //      anywhere empty (pointer-events: none).
  //   2. Position — bottom-center the composer inside the anchor.
  //   3. Hit target — the only rectangle that accepts clicks;
  //      SessionComposer renders MessageInput's own pill chrome, no
  //      backdrop/blur/card here.
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: rect.y,
        left: rect.x,
        width: rect.width,
        height: rect.height,
        zIndex: WEBVIEW_OVERLAY_Z,
        pointerEvents: "none",
      }}
      aria-hidden="false"
    >
      <div className="absolute inset-x-0 bottom-4 flex justify-center px-4">
        <div className="pointer-events-auto w-full max-w-2xl">
          <SessionComposer
            sessionId={activeSessionId}
            workspaceId={workspaceId}
            onSendComplete={onExit}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
