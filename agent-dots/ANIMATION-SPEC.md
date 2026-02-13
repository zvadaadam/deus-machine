# Agent Dots — Animation Spec

## Concept

A single white dot breathes to life, then spawns a spinning vortex of dots around it — representing an orchestrator awakening and coordinating multiple agents. Ends with the center dot consuming everything.

Black & white only. 1080x1080, 30fps, 10 seconds (300 frames).

---

## Timeline

### Phase 1: The Breath (0s — 2s)

The center dot **breathes once** — a single, fluid inhale-exhale.

- `0.0s` — Nothing. Black screen.
- `0.0s → 0.8s` — Dot fades in from invisible, grows from 0 to full size (~16px radius). Smooth ease-out.
- `0.8s → 1.2s` — Continues expanding slightly past resting size (overshoot to ~20px). The "inhale peak."
- `1.2s → 2.0s` — Settles back down to resting size (~14px). The "exhale." Smooth ease-in-out.

**Feel:** Like a heartbeat. One pulse. Alive.

---

### Phase 2: Rings Spawn + Spin (2s — 6s)

Four rings of dots appear **one by one**, each starting to spin as it forms. Inner rings first, expanding outward. Each ring is part of the vortex spiral.

- `2.0s → 2.8s` — **Ring 1** (innermost): ~6 dots at radius ~100px. Dots pop in one-by-one along the ring. Starts spinning immediately as dots appear.
- `3.0s → 3.8s` — **Ring 2**: ~8 dots at radius ~180px. Same pop-in + instant spin.
- `4.0s → 4.8s` — **Ring 3**: ~10 dots at radius ~280px.
- `5.0s → 5.8s` — **Ring 4** (outermost): ~12 dots at radius ~380px. Biggest dots.

**Vortex structure:**

- Each ring is slightly twisted from the previous one (the spiral offset from the reference math: `2π · turns · u`)
- All rings share the same global spin direction
- Dot sizes grow with radius: inner dots are small (~2px), outer dots are bigger (~5px)
- The spin accelerates gradually — slow at first, faster by the time all rings are in

**Feel:** Growing outward from the core. Each ring adds energy. The vortex structure becomes visible as rings accumulate.

---

### Phase 3: Full Vortex (6s — 8s)

All 4 rings are now spinning together. This is the "steady state" — the orchestrator is conducting.

- The vortex rotates smoothly, spiral arms clearly visible
- Subtle differential spin: inner rings rotate slightly faster than outer, creating that satisfying swirl/shear effect
- Dot sizes remain stable. No new dots appearing — just the beautiful spinning pattern.

**Feel:** Confident. Controlled. Geometric precision.

---

### Phase 4: The Opening (8s — 10s)

The center dot **expands** to consume everything.

- `8.0s → 8.5s` — Rings begin contracting inward (radii shrink toward center)
- `8.0s → 9.5s` — Center dot expands outward with spring physics (slow start, then accelerates)
- `8.5s → 9.5s` — Ring dots fade out as the center dot overtakes them
- `9.5s → 10.0s` — Pure white. Center dot has filled the entire canvas.

**Feel:** The orchestrator absorbs all the agents back. Clean resolution. White.

---

## Key Design Principles

1. **One breath, then action** — the opening breath is singular and purposeful, not a repeating animation
2. **4 distinct rings** (not 24 depth steps) — each ring is a discrete event with clear dot count
3. **Inner → outer** — always growing from the center
4. **Vortex geometry** — rings are twisted to form spiral arms, not concentric circles
5. **Spring physics** — center dot expansion uses spring for natural feel
6. **B&W only** — white dots on black background, no color
