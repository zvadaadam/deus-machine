import { useRef, useCallback, useEffect } from "react";

interface UseLongPressOptions {
  delay?: number;
  moveThreshold?: number;
}

/**
 * Touch-only long-press detection.
 * Returns touch handlers + a `didFire()` check to prevent the subsequent click.
 *
 * Usage:
 *   const lp = useLongPress(() => setOpen(true));
 *   <div {...lp.handlers} onClick={() => { if (!lp.didFire()) navigate(); }} />
 */
export function useLongPress(
  onLongPress: () => void,
  { delay = 300, moveThreshold = 10 }: UseLongPressOptions = {}
) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const startPosRef = useRef<{ x: number; y: number }>();
  const didFireRef = useRef(false);
  const callbackRef = useRef(onLongPress);

  // Sync after render — React Compiler forbids ref writes during render
  useEffect(() => {
    callbackRef.current = onLongPress;
  });

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      didFireRef.current = false;
      const touch = e.touches[0];
      startPosRef.current = { x: touch.clientX, y: touch.clientY };
      timerRef.current = setTimeout(() => {
        didFireRef.current = true;
        callbackRef.current();
      }, delay);
    },
    [delay]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPosRef.current) return;
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - startPosRef.current.x);
      const dy = Math.abs(touch.clientY - startPosRef.current.y);
      if (dx > moveThreshold || dy > moveThreshold) {
        clearTimeout(timerRef.current);
      }
    },
    [moveThreshold]
  );

  const cancel = useCallback(() => {
    clearTimeout(timerRef.current);
  }, []);

  return {
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd: cancel,
      onTouchCancel: cancel,
    },
    didFire: () => didFireRef.current,
  };
}
