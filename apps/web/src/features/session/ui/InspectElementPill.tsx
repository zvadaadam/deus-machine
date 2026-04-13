/**
 * InspectElementPill — inline pill rendered in chat messages for <inspect> tags.
 *
 * Context-aware:
 *   Local:    Cursor icon + tag name + text. Tooltip: file:line, React component.
 *   External: Palette icon + tag name + text. Tooltip: key CSS styles.
 */

import { MousePointer2, Palette } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { InspectElement } from "../lib/parseInspectTags";

interface InspectElementPillProps {
  element: InspectElement;
}

export function InspectElementPill({ element }: InspectElementPillProps) {
  const isExternal = element.context === "external";
  const Icon = isExternal ? Palette : MousePointer2;
  const label = element.innerText?.slice(0, 40) || element.tagName;

  // Build context-appropriate tooltip
  const tooltipLines: string[] = [];
  if (element.file) {
    tooltipLines.push(element.file + (element.line ? `:${element.line}` : ""));
  }
  if (element.reactComponent) {
    tooltipLines.push(`React: <${element.reactComponent} />`);
  }
  if (element.props) {
    // Show React props (most actionable data for local dev)
    const propEntries = element.props
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of propEntries.slice(0, 5)) {
      tooltipLines.push(entry);
    }
    if (propEntries.length > 5) {
      tooltipLines.push(`… +${propEntries.length - 5} more props`);
    }
  }
  if (element.attributes) {
    const attrEntries = element.attributes
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of attrEntries.slice(0, 4)) {
      tooltipLines.push(entry);
    }
  }
  if (element.styles) {
    // Show styles in tooltip (formatted as CSS lines)
    const styleEntries = element.styles
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of styleEntries.slice(0, 6)) {
      tooltipLines.push(entry);
    }
    if (styleEntries.length > 6) {
      tooltipLines.push(`… +${styleEntries.length - 6} more`);
    }
  }
  if (!tooltipLines.length) {
    tooltipLines.push(element.path);
  }
  const tooltipContent = tooltipLines.join("\n");

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="bg-primary/12 border-primary/20 text-foreground inline-flex cursor-help items-center gap-1 rounded-md border px-1.5 py-0.5 align-baseline text-xs leading-tight font-medium">
            <Icon className="text-primary inline-block h-3 w-3 shrink-0" />
            <span className="text-foreground/60 text-2xs font-mono">{`<${element.tagName}>`}</span>
            {element.innerText && <span className="max-w-[120px] truncate">{label}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-2xs font-mono break-all whitespace-pre-wrap">{tooltipContent}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
