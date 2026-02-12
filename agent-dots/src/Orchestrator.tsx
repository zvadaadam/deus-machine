import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from "remotion";

/**
 * Agent Dots — Orchestrator
 *
 * Phase 1 (0-1.5s): Center dot breathes (spring overshoot → settle → continuous pulse)
 * Phase 2 (1.5-4s): Ring 1 appears still → spin starts after ring 1 complete → rings 2-4
 * Phase 3 (4-7s): Full vortex spinning, differential swirl
 * Phase 4 (7-10s): Rings contract, center dot expands to white
 */

const CX = 540;
const CY = 540;

// ── 4 TIGHT RINGS — packed close ──
// Ring 1 appears at 1.5s, fully visible by ~2.0s
// Spin begins at 2.0s (after ring 1 complete), then rings 2-4 arrive
const RINGS = [
  { count: 6, radius: 90, dot: 2.0, appearAt: 1.5 },
  { count: 8, radius: 125, dot: 2.8, appearAt: 2.3 },
  { count: 10, radius: 165, dot: 3.5, appearAt: 2.9 },
  { count: 12, radius: 210, dot: 4.5, appearAt: 3.5 },
];

const TURNS = 0.35;

export const Orchestrator: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames: total } = useVideoConfig();

  // ════════════════════════════════════════════
  // PHASE 1: THE BREATH — organic entrance
  // 0.5s black → burst to 45px → visible wiggle settle to 20px
  // ════════════════════════════════════════════

  // Per-segment easing for organic wiggle (Emil Kowalski approach):
  // Each phase gets its own curve — no linear segments
  let centerBaseR: number;
  if (frame < 15) {
    // 0.5s delay
    centerBaseR = 0;
  } else if (frame < 30) {
    // Burst: ease-out — arrives fast, decelerates at peak
    centerBaseR = interpolate(frame, [15, 30], [0, 45], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
  } else if (frame < 48) {
    // Drop: ease-in — lingers at peak (weight), then accelerates down
    centerBaseR = interpolate(frame, [30, 48], [45, 16], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.55, 0.085, 0.68, 0.53), // ease-in-quad
    });
  } else if (frame < 57) {
    // Bounce up: ease-out — snappy recovery, soft at top
    centerBaseR = interpolate(frame, [48, 57], [16, 23], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
  } else if (frame < 64) {
    // Small dip: ease-in-out — gentle rocking
    centerBaseR = interpolate(frame, [57, 64], [23, 18], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.quad),
    });
  } else {
    // Final settle: ease-out — soft landing at 20
    centerBaseR = interpolate(frame, [64, 70], [18, 20], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.quad),
    });
  }

  // ════════════════════════════════════════════
  // PHASE 2-3: VORTEX SPIN (2.0s — 7s)
  // Spin only begins AFTER ring 1 is fully visible
  // ════════════════════════════════════════════

  const spinStart = 2.0 * fps;
  const rotT = interpolate(frame, [spinStart, total], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const omega = Math.pow(rotT, 1.8) * Math.PI * 10;

  // Differential swirl: ease-in — gentle start, intensifies as vortex winds up
  const alpha = interpolate(frame, [spinStart, total], [0, 2.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.55, 0.055, 0.675, 0.19), // ease-in-cubic
  });

  // ════════════════════════════════════════════
  // PHASE 3.5: PRE-PULL BREATH (5.0s → 6.0s)
  // Center dot inhales (swells) → exhales (shrinks) before the pull
  // Like gathering energy before the plunge
  // ════════════════════════════════════════════

  // Pre-pull breath with per-segment easing:
  // Inhale (ease-out): quick swell, decelerates at peak
  // Exhale (ease-in): lingers at expanded, snaps back — anticipation before pull
  const prePullBreath =
    frame < 5.4 * fps
      ? interpolate(frame, [5.0 * fps, 5.4 * fps], [1.0, 1.5], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        })
      : interpolate(frame, [5.4 * fps, 6.0 * fps], [1.5, 1.0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.55, 0.085, 0.68, 0.53), // ease-in-quad
        });

  // ════════════════════════════════════════════
  // PHASE 4: THE PULL (6s — 7s) — 1 second, fast
  // ════════════════════════════════════════════

  const rScale = interpolate(frame, [6.0 * fps, 6.8 * fps], [1, 0.02], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.exp),
  });

  // Dots hold brightness then rapidly vanish — consumed by the pull
  const dotsAlpha = interpolate(frame, [6.0 * fps, 6.7 * fps], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.55, 0.085, 0.68, 0.53), // ease-in-quad
  });

  // Gravitational pull — 1 second, starts fast, accelerates harder
  const centerExpand = interpolate(frame, [6.0 * fps, 7.0 * fps], [1, 55], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.4, 0, 1, 0.15),
  });

  const centerR = centerBaseR * prePullBreath * centerExpand;

  // ════════════════════════════════════════════
  // BUILD RING DOTS
  // ════════════════════════════════════════════

  const dots: Array<{ cx: number; cy: number; r: number; o: number }> = [];

  for (let ringIdx = 0; ringIdx < RINGS.length; ringIdx++) {
    const ring = RINGS[ringIdx];
    const u = ringIdx / (RINGS.length - 1);
    const radius = ring.radius * rScale;

    const spawnDuration = 0.5 * fps; // faster ring fill
    const perDotDelay = spawnDuration / ring.count;

    for (let j = 0; j < ring.count; j++) {
      const dotSpawn = ring.appearAt * fps + j * perDotDelay;

      // Use spring for each dot appearance too — fluid pop-in
      const dotAge = Math.max(0, frame - dotSpawn);
      const appear =
        dotAge > 0
          ? spring({
              frame: dotAge,
              fps,
              config: { damping: 12, stiffness: 120, mass: 0.5 },
              durationInFrames: 0.4 * fps,
            })
          : 0;
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

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <svg width={1080} height={1080} viewBox="0 0 1080 1080">
        {dots.map((d, i) =>
          d.o > 0.01 ? (
            <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill="#fff" opacity={d.o} />
          ) : null
        )}
        {centerR > 0.1 && <circle cx={CX} cy={CY} r={centerR} fill="#fff" />}
      </svg>
    </AbsoluteFill>
  );
};
