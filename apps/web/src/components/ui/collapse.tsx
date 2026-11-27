import { m, useReducedMotion, type HTMLMotionProps } from "framer-motion";
import { cn } from "@/shared/lib/utils";
import { tempo } from "@/shared/lib/tempo";

/** AnimatePresence keeps the details mounted until their closing fade finishes. */
export function Collapse({
  initial = true,
  tier = "moderate",
  className,
  ...props
}: Pick<HTMLMotionProps<"div">, "id" | "className" | "role" | "children"> & {
  initial?: boolean;
  tier?: "fast" | "moderate";
}) {
  // MotionConfig handles transforms and layout projection. An explicit height needs its own target.
  const reduced = useReducedMotion();
  const closed = reduced ? { opacity: 0 } : { opacity: 0, height: 0 };
  const open = reduced ? { opacity: 1 } : { opacity: 1, height: "auto" };
  return (
    <m.div
      initial={initial && closed}
      animate={open}
      exit={{ ...closed, transition: tempo[tier].exit }}
      transition={reduced ? tempo[tier] : tempo.spring[tier]}
      className={cn("overflow-hidden", className)}
      {...props}
    />
  );
}
