/**
 * useTextBuffer — Smooth text streaming buffer
 *
 * Takes the full text during streaming and returns a "display text"
 * that catches up to the full text at a controlled rate.
 */

import { useState, useRef, useEffect } from "react";

const CHARS_PER_FRAME = 30;
const MAX_GAP = 200;
const CATCHUP_RATE = 80;

export function useTextBuffer(fullText: string, isStreaming: boolean): string {
  const [displayText, setDisplayText] = useState(fullText);
  const displayLengthRef = useRef(fullText.length);
  const rafRef = useRef<number | null>(null);
  const fullTextRef = useRef(fullText);

  // Sync fullText ref in effect
  useEffect(() => {
    fullTextRef.current = fullText;
  }, [fullText]);

  // rAF-based catch-up during streaming
  useEffect(() => {
    if (!isStreaming) {
      // Flush immediately when streaming stops
      displayLengthRef.current = fullText.length;
      return;
    }

    if (fullText.length <= displayLengthRef.current) return;

    function tick() {
      const current = fullTextRef.current;
      const target = current.length;
      const pos = displayLengthRef.current;

      if (pos >= target) {
        rafRef.current = null;
        return;
      }

      const gap = target - pos;
      const rate = gap > MAX_GAP ? CATCHUP_RATE : CHARS_PER_FRAME;
      const next = Math.min(pos + rate, target);

      // Safety: don't cut inside unclosed markdown code fence
      const slice = current.slice(0, next);
      const lastFenceStart = slice.lastIndexOf("```");
      if (lastFenceStart !== -1) {
        const afterFence = slice.slice(lastFenceStart);
        const fenceCount = (afterFence.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) {
          displayLengthRef.current = target;
          setDisplayText(current);
          rafRef.current = null;
          return;
        }
      }

      displayLengthRef.current = next;
      setDisplayText(current.slice(0, next));
      rafRef.current = requestAnimationFrame(tick);
    }

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [fullText, isStreaming]);

  // When not streaming, always return full text (no buffering)
  if (!isStreaming) return fullText;
  return displayText;
}
