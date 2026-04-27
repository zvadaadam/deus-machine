/**
 * InspectPromptOverlay — floating inspect prompt that appears after a
 * user clicks an element in browser inspect mode.
 *
 * Portaled to document.body above the webview (WEBVIEW_OVERLAY_Z). Anchors
 * to the clicked element's viewport rect translated into host-screen
 * coordinates using the webview's own screen bounds — the webview container
 * already sits at the mobile-view centering offset, so no extra math is
 * needed for mobile emulation.
 *
 * The overlay owns its own textarea state. On submit it calls back to the
 * parent (BrowserPanel), which runs the "hide inspector chrome → capture
 * region → restore → dispatch to composer" sequence. Escape dismisses
 * without submitting, and clicking another page element simply retargets
 * the prompt.
 */
/* eslint-env browser */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, MousePointer2 } from "lucide-react";
import { m } from "framer-motion";
import { InputGroup, InputGroupButton } from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import type { ElementSelectedEvent } from "../types";
import { WEBVIEW_OVERLAY_Z, type Bounds } from "../webview-manager";

interface InspectPromptOverlayProps {
  /** Source event for the currently-selected element. Prompt re-anchors +
   *  clears the textarea whenever this changes (user clicked a new element). */
  event: ElementSelectedEvent;
  /** Screen-space bounds of the host webview container — used to translate
   *  the guest-viewport rect into host-window coordinates. Pass the same
   *  rect the `useWebview` hook is handed. */
  webviewBounds: Bounds | null;
  /** Fires when the user submits (non-empty text + Enter). The parent runs
   *  the capture + compose sequence; we stay mounted until it resolves so
   *  double-Enter is debounced by `isSubmitting`. */
  onSubmit: (text: string) => Promise<void>;
  /** User dismissed (Escape, resize invalidation). No text is submitted. */
  onDismiss: () => void;
}

/** Max width of the prompt; clamps down on narrow layouts/mobile web. */
const OVERLAY_MAX_WIDTH = 420;
/** Vertical gap between the element and the prompt. */
const ANCHOR_GAP = 8;
/** Minimum distance from the viewport edges. */
const VIEWPORT_PADDING = 12;
/** Height we assume when deciding above/below. The textarea is smaller on
 *  first render but grows as the user types — taking a safe ceiling keeps
 *  the "would this overflow" check honest without measuring post-layout. */
const ASSUMED_OVERLAY_HEIGHT = 110;

interface ScreenAnchor {
  /** Element's rect in host-screen coords. */
  x: number;
  y: number;
  width: number;
  height: number;
}

function resolveAnchor(event: ElementSelectedEvent, wv: Bounds | null): ScreenAnchor | null {
  if (!wv || !event.element) return null;
  const r = event.element.rect;
  return {
    x: wv.x + r.left,
    y: wv.y + r.top,
    width: r.width,
    height: r.height,
  };
}

interface OverlayPlacement {
  top: number;
  left: number;
  width: number;
  /** True when we placed the prompt above the element instead of below. */
  flippedAbove: boolean;
}

function placeOverlay(anchor: ScreenAnchor): OverlayPlacement {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const width = Math.min(OVERLAY_MAX_WIDTH, Math.max(0, viewportW - VIEWPORT_PADDING * 2));

  // Horizontal: align the overlay's left with the element's left by default;
  // if the element is wider than the overlay, align left-to-left anyway
  // (visually anchors to the element's start, matches Cursor).
  let left = anchor.x;
  left = Math.max(VIEWPORT_PADDING, left);
  left = Math.min(left, viewportW - width - VIEWPORT_PADDING);

  // Vertical: below by default; flip above if no room.
  const belowTop = anchor.y + anchor.height + ANCHOR_GAP;
  const fitsBelow = belowTop + ASSUMED_OVERLAY_HEIGHT <= viewportH - VIEWPORT_PADDING;

  if (fitsBelow) {
    return { top: belowTop, left, width, flippedAbove: false };
  }

  const aboveTop = anchor.y - ASSUMED_OVERLAY_HEIGHT - ANCHOR_GAP;
  if (aboveTop >= VIEWPORT_PADDING) {
    return { top: aboveTop, left, width, flippedAbove: true };
  }

  // Can't fit on either side — clamp inside the viewport, below the element
  // if possible, otherwise at the top. This is the edge-case for full-
  // viewport elements; the prompt will overlap the element visually.
  const clampedTop = Math.min(
    Math.max(belowTop, VIEWPORT_PADDING),
    viewportH - ASSUMED_OVERLAY_HEIGHT - VIEWPORT_PADDING
  );
  return { top: clampedTop, left, width, flippedAbove: false };
}

/** Pick the best label for the pill: React component name > tag name. */
function labelForEvent(event: ElementSelectedEvent): string {
  const name = event.reactComponent?.name;
  if (name) return name;
  const tag = event.element?.tagName;
  return tag ? `<${tag}>` : "element";
}

export function InspectPromptOverlay({
  event,
  webviewBounds,
  onSubmit,
  onDismiss,
}: InspectPromptOverlayProps) {
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const anchor = useMemo(() => resolveAnchor(event, webviewBounds), [event, webviewBounds]);
  const [placement, setPlacement] = useState<OverlayPlacement | null>(() =>
    anchor ? placeOverlay(anchor) : null
  );

  // Re-place whenever the event or webview bounds change (new element click,
  // window resize, mobile-view toggle). We intentionally don't live-track
  // the guest element rect after the click.
  useLayoutEffect(() => {
    if (!anchor) {
      setPlacement(null);
      return;
    }
    setPlacement(placeOverlay(anchor));
  }, [anchor]);

  // Reset textarea + submit guard whenever a new element is targeted so
  // swapping targets feels fresh. Keyed on event identity.
  useEffect(() => {
    setText("");
    setIsSubmitting(false);
  }, [event]);

  // Focus the textarea on mount and whenever the target swaps.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [event]);

  // Window resize invalidates the cached anchor math (the webview moves +
  // the guest rect reported at click time no longer maps to the same
  // screen coords). Dismissing is the safe answer for v1; live-follow is
  // scope for a follow-up. Scroll events are NOT a reliable signal here:
  // guest-page scroll never bubbles to the host, and the only scrolls we
  // would see are unrelated host containers (e.g. the composer auto-
  // scrolling when new cards land), which would spuriously cancel.
  useEffect(() => {
    const onResize = () => onDismiss();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onDismiss]);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setIsSubmitting(false);
    }
  }, [text, isSubmitting, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !isComposing) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit, isComposing, onDismiss]
  );

  if (!placement) return null;

  const disabled = isSubmitting || text.trim().length === 0;
  const label = labelForEvent(event);

  return createPortal(
    <m.div
      key={event.ref ?? event.timestamp}
      role="dialog"
      aria-label="Describe change for selected element"
      initial={{ opacity: 0, scale: 0.96, y: placement.flippedAbove ? 4 : -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.215, 0.61, 0.355, 1] }}
      style={{
        position: "fixed",
        top: placement.top,
        left: placement.left,
        width: placement.width,
        zIndex: WEBVIEW_OVERLAY_Z + 1,
      }}
      className="bg-bg-overlay/90 ring-border-subtle rounded-2xl shadow-lg ring-1 backdrop-blur-xl"
    >
      {/* Element pill — matches InspectedElementCard's chip style */}
      <div className="flex items-center gap-1.5 px-3 pt-2">
        <div className="bg-primary/8 border-primary/20 text-foreground/80 flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-2 text-xs">
          <MousePointer2 className="text-primary/70 h-3 w-3 shrink-0" />
          <span className="max-w-[180px] truncate">{label}</span>
        </div>
      </div>

      <InputGroup data-no-ring className="border-0 bg-transparent shadow-none">
        <Textarea
          ref={textareaRef}
          data-slot="input-group-control"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder="Describe what to change…"
          rows={1}
          className="max-h-[200px] min-h-[48px] flex-1 resize-none rounded-none border-0 bg-transparent py-2 shadow-none focus-visible:ring-0"
          disabled={isSubmitting}
        />
        <div
          data-slot="input-group-addon"
          data-align="inline-end"
          className="order-last flex items-center pr-2 pb-2"
        >
          <InputGroupButton
            type="button"
            variant="default"
            size="icon-sm"
            className="rounded-full"
            onClick={() => void handleSubmit()}
            disabled={disabled}
            aria-label="Send to chat (Enter)"
          >
            <ArrowUp className="h-4 w-4" />
          </InputGroupButton>
        </div>
      </InputGroup>
    </m.div>,
    document.body
  );
}
