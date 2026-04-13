/**
 * Streaming Reasoning Block
 *
 * Shows reasoning text in real-time during active thinking.
 * Renders a "Thinking" header with shimmer + pulsing dot,
 * and a constrained preview window with a longer top gradient fade
 * (the "peephole" effect). Text auto-scrolls
 * to the bottom as new tokens arrive.
 *
 * When the reasoning part transitions to DONE, PartsRenderer
 * switches to the collapsed ThinkingBlock.
 */

import { useLayoutEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

interface StreamingReasoningBlockProps {
  text: string;
}

const PREVIEW_HEIGHT_PX = 104;
const PREVIEW_FADE_HEIGHT_PX = 40;

export function StreamingReasoningBlock({ text }: StreamingReasoningBlockProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const previewMask = `linear-gradient(to bottom, var(--mask-transparent) 0, var(--mask-solid) ${PREVIEW_FADE_HEIGHT_PX}px, var(--mask-solid) 100%)`;

  // Auto-scroll to bottom as new text arrives
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!text.trim()) return null;

  return (
    <div className="flex flex-col gap-1">
      {/* Header: pulsing dot + shimmering label */}
      <div className="flex items-center gap-2 px-2 py-1">
        <motion.span
          className="bg-primary/70 h-1.5 w-1.5 shrink-0 rounded-full"
          animate={reduceMotion ? undefined : { opacity: [0.45, 1], scale: [0.92, 1] }}
          transition={
            reduceMotion
              ? undefined
              : {
                  duration: 1,
                  repeat: Infinity,
                  repeatType: "reverse",
                  ease: [0.37, 0, 0.63, 1],
                }
          }
        />
        <span className="text-muted-foreground tool-loading-shimmer text-sm font-medium">
          Thinking
        </span>
      </div>

      {/* Preview window with top fade */}
      <div
        ref={scrollRef}
        className="chat-scroll-contain scrollbar-hidden mx-2 max-h-[104px] overflow-x-hidden overflow-y-auto"
        style={{
          maxHeight: PREVIEW_HEIGHT_PX,
          WebkitMaskImage: previewMask,
          maskImage: previewMask,
        }}
      >
        <p className="text-muted-foreground/50 min-w-0 py-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
          {text}
        </p>
      </div>
    </div>
  );
}
