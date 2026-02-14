import { useRef, useCallback, useEffect, useMemo } from "react";

// Volume and fade timing — tweak these to adjust audio feel
const MAX_VOLUME = 0.4;
const FADE_IN_MS = 500;
const FADE_OUT_MS = 600;

/** Manages onboarding audio with fade-in/out. Returns { play, fadeOut, stop }. */
export function useOnboardingAudio(src: string) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number>(0);

  // Cleanup on unmount — stop any playing audio and cancel fades
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const play = useCallback(() => {
    const existing = audioRef.current;

    // Already playing — don't restart (prevents the loop bug where
    // useEffect re-triggers could restart the song)
    if (existing && !existing.paused) return;

    // Exists but paused (e.g. autoplay was blocked) — resume from beginning
    if (existing) {
      cancelAnimationFrame(rafRef.current);
      existing.currentTime = 0;
      existing.volume = 0;
      existing.play().catch((e) => console.warn("[Audio] play() failed:", e));
    } else {
      // First call — create the audio element
      const audio = new Audio(src);
      audio.loop = false;
      audio.volume = 0;
      audioRef.current = audio;
      audio.play().catch((e) => console.warn("[Audio] play() failed:", e));
    }

    // Fade in volume over FADE_IN_MS
    const audio = audioRef.current!;
    const start = performance.now();
    const fadeIn = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / FADE_IN_MS, 1);
      audio.volume = progress * MAX_VOLUME;
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(fadeIn);
      }
    };
    rafRef.current = requestAnimationFrame(fadeIn);
  }, [src]);

  const fadeOut = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    cancelAnimationFrame(rafRef.current);
    const startVol = audio.volume;
    const start = performance.now();

    const fade = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / FADE_OUT_MS, 1);
      audio.volume = startVol * (1 - progress);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(fade);
      } else {
        audio.pause();
        audioRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(fade);
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  // Stable reference — prevents useEffect re-triggers in consumers.
  // Without useMemo, a new object is created each render, causing
  // any useEffect with [audio] dependency to re-run and restart timers.
  return useMemo(() => ({ play, fadeOut, stop }), [play, fadeOut, stop]);
}
