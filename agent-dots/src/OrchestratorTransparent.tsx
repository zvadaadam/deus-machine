/**
 * Transparent-background variant of the Orchestrator animation.
 * Used solely for rendering WebM with alpha channel.
 */
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from "remotion";

const CX = 540;
const CY = 540;

const RINGS = [
  { count: 6, radius: 90, dot: 2.0, appearAt: 1.5 },
  { count: 8, radius: 125, dot: 2.8, appearAt: 2.3 },
  { count: 10, radius: 165, dot: 3.5, appearAt: 2.9 },
  { count: 12, radius: 210, dot: 4.5, appearAt: 3.5 },
];

const TURNS = 0.35;

export const OrchestratorTransparent: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames: total } = useVideoConfig();

  // Phase 1: The Breath
  let centerBaseR: number;
  if (frame < 15) {
    centerBaseR = 0;
  } else if (frame < 30) {
    centerBaseR = interpolate(frame, [15, 30], [0, 45], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
  } else if (frame < 48) {
    centerBaseR = interpolate(frame, [30, 48], [45, 16], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.55, 0.085, 0.68, 0.53),
    });
  } else if (frame < 57) {
    centerBaseR = interpolate(frame, [48, 57], [16, 23], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
  } else if (frame < 64) {
    centerBaseR = interpolate(frame, [57, 64], [23, 18], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.quad),
    });
  } else {
    centerBaseR = interpolate(frame, [64, 70], [18, 20], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.quad),
    });
  }

  // Phase 2-3: Vortex spin
  const spinStart = 2.0 * fps;
  const rotT = interpolate(frame, [spinStart, total], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const omega = Math.pow(rotT, 1.8) * Math.PI * 10;
  const alpha = interpolate(frame, [spinStart, total], [0, 2.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.55, 0.055, 0.675, 0.19),
  });

  // Phase 3.5: Pre-pull breath
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
          easing: Easing.bezier(0.55, 0.085, 0.68, 0.53),
        });

  // Phase 4: The Pull
  const rScale = interpolate(frame, [6.0 * fps, 6.8 * fps], [1, 0.02], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.exp),
  });
  const dotsAlpha = interpolate(frame, [6.0 * fps, 6.7 * fps], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.55, 0.085, 0.68, 0.53),
  });
  const centerExpand = interpolate(frame, [6.0 * fps, 7.0 * fps], [1, 55], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.4, 0, 1, 0.15),
  });

  const centerR = centerBaseR * prePullBreath * centerExpand;

  // Build ring dots
  const dots: Array<{ cx: number; cy: number; r: number; o: number }> = [];

  for (let ringIdx = 0; ringIdx < RINGS.length; ringIdx++) {
    const ring = RINGS[ringIdx];
    const u = ringIdx / (RINGS.length - 1);
    const radius = ring.radius * rScale;
    const spawnDuration = 0.5 * fps;
    const perDotDelay = spawnDuration / ring.count;

    for (let j = 0; j < ring.count; j++) {
      const dotSpawn = ring.appearAt * fps + j * perDotDelay;
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
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
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
