import type { ReactNode } from "react";
import { m } from "framer-motion";
import { tempo } from "@/shared/lib/tempo";

export function ComposerTray({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <m.div
      className="bg-bg-muted dark:bg-bg-surface border-border-strong absolute inset-x-2 bottom-full -mb-4 overflow-hidden rounded-t-2xl border"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4, transition: tempo.fast.exit }}
      transition={tempo.fast}
    >
      <div
        role="listbox"
        id={id}
        aria-label={label}
        className="bg-control-hover box-content flex max-h-[min(320px,40dvh)] flex-col pb-4"
      >
        {children}
      </div>
    </m.div>
  );
}
