/**
 * InspectedElementCard — compact chip shown above the chat textarea
 * when a user selects an element via InSpec mode.
 *
 * Designed as a slim label: confirms the element is attached without
 * showing raw data (that goes to the AI in the serialized <inspect> tag).
 * Shows: icon + <tag> + identifier (React component or text preview).
 */

import { X, MousePointer2, Palette } from "lucide-react";
import { m } from "framer-motion";
import type { InspectElement } from "../lib/parseInspectTags";

export interface InspectedElement extends InspectElement {
  id: string;
}

interface InspectedElementCardProps {
  element: InspectedElement;
  onRemove: () => void;
}

export function InspectedElementCard({ element, onRemove }: InspectedElementCardProps) {
  const isExternal = element.context === "external";
  const Icon = isExternal ? Palette : MousePointer2;

  // Best identifier: React component name > inner text > file basename
  const identifier =
    element.reactComponent ||
    element.innerText?.slice(0, 30) ||
    (element.file ? element.file.split("/").pop() : null) ||
    element.path.split(" > ").pop();

  return (
    <m.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15, ease: [0.165, 0.84, 0.44, 1] }}
      className="group bg-primary/8 border-primary/20 relative flex shrink-0 items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-2"
    >
      <Icon className="text-primary/70 h-3 w-3 shrink-0" />
      <span className="text-foreground/50 text-2xs font-mono">{`<${element.tagName}>`}</span>
      <span className="text-foreground/80 max-w-[120px] truncate text-xs">{identifier}</span>
      <button
        onClick={onRemove}
        className="text-foreground/30 hover:text-foreground/60 ease ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-200"
        aria-label="Remove inspected element"
      >
        <X className="h-3 w-3" />
      </button>
    </m.div>
  );
}
