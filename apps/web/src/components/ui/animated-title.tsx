import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createTitleTyper, type TitleTyper, type TitleTyperFrame } from "@/shared/lib/titleTyper";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

function getReducedMotionServerSnapshot(): boolean {
  return false;
}

/**
 * Animates live renames of a single entity by peeling away the old suffix
 * and smoothly fading in the new characters — no caret, no mount animation,
 * and immediate snap on entity change or live reduced-motion toggles.
 */
export function AnimatedTitle({ text, entityId }: { text: string; entityId: string }) {
  const reducedMotion = React.useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot
  );
  const [frame, setFrame] = useState<TitleTyperFrame>(() => ({
    entityId,
    target: text,
    solid: text,
    tail: [],
    reserve: [],
  }));
  const typerRef = useRef<TitleTyper | null>(null);
  const initialRef = useRef({ entityId, text });

  useIsomorphicLayoutEffect(() => {
    const typer = createTitleTyper(initialRef.current, setFrame);
    typerRef.current = typer;
    return () => {
      typer.dispose();
      typerRef.current = null;
    };
  }, []);

  useIsomorphicLayoutEffect(() => {
    typerRef.current?.set(entityId, text, reducedMotion);
  }, [entityId, text, reducedMotion]);

  if (reducedMotion || frame.reserve.length === 0) {
    return <>{text}</>;
  }

  return (
    <>
      <span aria-hidden="true">
        {frame.solid.length === 0 && frame.tail.length === 0 ? (
          "\u200B"
        ) : (
          <>
            {frame.solid}
            {frame.tail.map((item, index) => (
              <span key={index} style={{ opacity: item.opacity }}>
                {item.char}
              </span>
            ))}
          </>
        )}
      </span>
      <span className="sr-only">{text}</span>
      {frame.reserve.map((ghost, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="invisible block h-0 overflow-hidden select-none"
        >
          {ghost}
        </span>
      ))}
    </>
  );
}
