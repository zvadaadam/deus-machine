import { useCallback, useEffect, useRef, useState } from "react";
import { Easing, interpolate, spring } from "./animation-utils";

// ── Configuration ──

const CX = 540;
const CY = 540;
const VIEWBOX = 1080;
const FPS = 30;
const TOTAL_FRAMES = 300; // 10 seconds

const RINGS = [
  { count: 6, radius: 90, dot: 2.0, appearAt: 1.5 },
  { count: 8, radius: 125, dot: 2.8, appearAt: 2.3 },
  { count: 10, radius: 165, dot: 3.5, appearAt: 2.9 },
  { count: 12, radius: 210, dot: 4.5, appearAt: 3.5 },
];

const TURNS = 0.35;

// ── Easing presets (matching Remotion originals) ──

const easeOutCubic = Easing.out(Easing.cubic);
const easeInQuad = Easing.bezier(0.55, 0.085, 0.68, 0.53);
const easeInOutQuad = Easing.inOut(Easing.quad);
const easeOutQuad = Easing.out(Easing.quad);
const easeInCubic = Easing.bezier(0.55, 0.055, 0.675, 0.19);
const easeInExp = Easing.in(Easing.exp);
const pullEasing = Easing.bezier(0.4, 0, 1, 0.15);

// ── Props ──

export interface AgentDotsAnimationProps {
  /** Width/height of the container in CSS pixels. SVG scales to fit. */
  size?: number;
  /** Dot color. Defaults to white. */
  dotColor?: string;
  /** Background color. Use "transparent" for no background. */
  backgroundColor?: string;
  /** Start playing immediately. Defaults to true. */
  autoPlay?: boolean;
  /** Loop the animation. Defaults to false. */
  loop?: boolean;
  /** Called when the animation completes (not called if looping). */
  onComplete?: () => void;
  className?: string;
}

// ── Component ──

export function AgentDotsAnimation({
  size,
  dotColor = "#fff",
  backgroundColor = "transparent",
  autoPlay = true,
  loop = false,
  onComplete,
  className,
}: AgentDotsAnimationProps) {
  const [frame, setFrame] = useState(0);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number | null>(null);
  const playingRef = useRef(autoPlay);
  const tickRef = useRef<(timestamp: number) => void>();

  const tick = useCallback(
    (timestamp: number) => {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const currentFrame = Math.floor((elapsed / 1000) * FPS);

      if (currentFrame >= TOTAL_FRAMES) {
        if (loop) {
          startTimeRef.current = timestamp;
          setFrame(0);
        } else {
          setFrame(TOTAL_FRAMES);
          playingRef.current = false;
          onComplete?.();
          return;
        }
      } else {
        setFrame(currentFrame);
      }

      if (tickRef.current) {
        rafRef.current = requestAnimationFrame(tickRef.current);
      }
    },
    [loop, onComplete]
  );

  useEffect(() => {
    // Store tick function in ref to avoid closure issues
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (autoPlay) {
      playingRef.current = true;
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [autoPlay, tick]);

  // ── Compute frame ──

  const { dots, centerR } = computeFrame(frame);

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        backgroundColor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        style={{ display: "block" }}
      >
        {dots.map((d, i) =>
          d.o > 0.01 ? (
            <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={dotColor} opacity={d.o} />
          ) : null
        )}
        {centerR > 0.1 && <circle cx={CX} cy={CY} r={centerR} fill={dotColor} />}
      </svg>
    </div>
  );
}

// ── Pure computation (no React, no side effects) ──

function computeFrame(frame: number) {
  // Phase 1: The Breath — organic entrance
  let centerBaseR: number;
  if (frame < 15) {
    centerBaseR = 0;
  } else if (frame < 30) {
    centerBaseR = interpolate(frame, [15, 30], [0, 45], { easing: easeOutCubic });
  } else if (frame < 48) {
    centerBaseR = interpolate(frame, [30, 48], [45, 16], { easing: easeInQuad });
  } else if (frame < 57) {
    centerBaseR = interpolate(frame, [48, 57], [16, 23], { easing: easeOutCubic });
  } else if (frame < 64) {
    centerBaseR = interpolate(frame, [57, 64], [23, 18], { easing: easeInOutQuad });
  } else {
    centerBaseR = interpolate(frame, [64, 70], [18, 20], { easing: easeOutQuad });
  }

  // Phase 2-3: Vortex spin
  const spinStart = 2.0 * FPS;
  const rotT = interpolate(frame, [spinStart, TOTAL_FRAMES], [0, 1]);
  const omega = Math.pow(rotT, 1.8) * Math.PI * 10;
  const alpha = interpolate(frame, [spinStart, TOTAL_FRAMES], [0, 2.0], { easing: easeInCubic });

  // Phase 3.5: Pre-pull breath
  const prePullBreath =
    frame < 5.4 * FPS
      ? interpolate(frame, [5.0 * FPS, 5.4 * FPS], [1.0, 1.5], { easing: easeOutCubic })
      : interpolate(frame, [5.4 * FPS, 6.0 * FPS], [1.5, 1.0], { easing: easeInQuad });

  // Phase 4: The Pull
  const rScale = interpolate(frame, [6.0 * FPS, 6.8 * FPS], [1, 0.02], { easing: easeInExp });
  const dotsAlpha = interpolate(frame, [6.0 * FPS, 6.7 * FPS], [1, 0], { easing: easeInQuad });
  const centerExpand = interpolate(frame, [6.0 * FPS, 7.0 * FPS], [1, 55], { easing: pullEasing });

  const centerR = centerBaseR * prePullBreath * centerExpand;

  // Build ring dots
  const dots: Array<{ cx: number; cy: number; r: number; o: number }> = [];

  for (let ringIdx = 0; ringIdx < RINGS.length; ringIdx++) {
    const ring = RINGS[ringIdx];
    const u = ringIdx / (RINGS.length - 1);
    const radius = ring.radius * rScale;
    const spawnDuration = 0.5 * FPS;
    const perDotDelay = spawnDuration / ring.count;

    for (let j = 0; j < ring.count; j++) {
      const dotSpawn = ring.appearAt * FPS + j * perDotDelay;
      const dotAge = Math.max(0, frame - dotSpawn);

      const appear =
        dotAge > 0 ? spring(dotAge, FPS, { damping: 12, stiffness: 120, mass: 0.5 }, 0.4 * FPS) : 0;
      if (appear <= 0) continue;

      const theta =
        (2 * Math.PI * j) / ring.count + 2 * Math.PI * TURNS * u + omega + alpha * (1 - u);

      dots.push({
        cx: CX + Math.cos(theta) * radius,
        cy: CY + Math.sin(theta) * radius,
        r: ring.dot * appear,
        o: appear * dotsAlpha,
      });
    }
  }

  return { dots, centerR };
}
