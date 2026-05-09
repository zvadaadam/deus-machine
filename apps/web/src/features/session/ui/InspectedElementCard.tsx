/**
 * InspectedElementCard — slim chip shown above the chat textarea when a
 * user selects an element via inspect mode. Uses the shared <MentionChip>
 * primitive with the primary tone. Confirms the element is attached
 * without showing raw data (that goes to the AI in the serialized
 * <inspect> tag).
 *
 * Label: <tag> + identifier (React component name > inner text > file
 * basename > path leaf).
 */

import { MousePointer2, Palette } from "lucide-react";
import { MentionChip } from "@/components/ui/mention-chip";
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

  const identifier =
    element.reactComponent ||
    element.innerText?.slice(0, 30) ||
    (element.file ? element.file.split("/").pop() : null) ||
    element.path.split(" > ").pop();

  return (
    <MentionChip icon={Icon} onRemove={onRemove} removeAriaLabel="Remove inspected element">
      <span className="text-foreground/50 text-2xs font-mono">{`<${element.tagName}>`}</span>
      <span className="text-foreground/80 max-w-[120px] truncate text-xs">{identifier}</span>
    </MentionChip>
  );
}
