const ease = [0.165, 0.84, 0.44, 1] as const;

const move = [0.25, 0.1, 0.25, 1] as const;

function tier(duration: number, exit: number) {
  return { duration, ease, exit: { duration: exit, ease }, layout: { duration, ease: move } };
}

/** Framer Motion measures time in seconds. The CSS tokens are in milliseconds. */
export const tempo = {
  fast: tier(0.08, 0.06),
  moderate: tier(0.16, 0.12),
  slow: tier(0.24, 0.16),
  step: 0.06,
};
