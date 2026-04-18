// Themed select — Radix UI primitives + plain CSS against our token system.
// Matches the visual of apps/web's Shadcn Select but without the Tailwind deps.

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

// Radix's typings pull React from a different node_modules copy in
// workspaces, producing a structural mismatch against our React 19
// ReactNode. Cast at the ItemText boundary only.
type AnyNode = Parameters<typeof SelectPrimitive.ItemText>[0]["children"];

export interface SelectOption {
  value: string;
  label: ReactNode;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Minimum width of the trigger; useful when options have varying length. */
  minWidth?: number;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  minWidth,
}: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={`select-trigger ${className ?? ""}`}
        style={minWidth ? { minWidth } : undefined}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown size={14} className="select-chevron" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="select-content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport className="select-viewport">
            {options.map((opt) => (
              <SelectPrimitive.Item key={opt.value} value={opt.value} className="select-item">
                <SelectPrimitive.ItemIndicator asChild>
                  <Check size={14} className="select-check" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{opt.label as AnyNode}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
