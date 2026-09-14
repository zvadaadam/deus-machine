/**
 * TabPill — shared primitive for Browser/Session/Terminal tab bars.
 *
 * Layout: [icon-slot][title]. The icon slot shows the supplied icon at rest;
 * when `onClose` is provided, the slot becomes a button that reveals an X
 * on hover. Both icons stay mounted so switching does not move the label.
 *
 * Click the title button to select; click the icon slot (when closable) to
 * close. The component sets role="tab" + aria-selected on the title button,
 * so callers should wrap it in a role="tablist" container.
 */

import type { KeyboardEvent, ReactNode, RefCallback } from "react";
import { X } from "lucide-react";
import { cn } from "@/shared/lib/utils";

type TabPillPropsBase = {
  /** Whether this tab is currently active. Drives bg + text color. */
  active: boolean;
  /** Rest-state icon shown in the left slot. Sized by the caller — typically
   *  `h-3.5 w-3.5` for the matching toolbar visual rhythm. */
  icon: ReactNode;
  /** Click handler for the title button. */
  onSelect: () => void;
  /** Title content. Truncates by default. */
  children: ReactNode;
  /** Forwarded keyboard handler on the title button (arrow-key tab nav). */
  onTitleKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Forwarded tabIndex for the title button (used for roving focus). */
  titleTabIndex?: number;
  /** Forwarded ref to the title button (used for focus management). */
  titleRef?: RefCallback<HTMLButtonElement>;
  /** Container className override — for max-width, min-width, custom text
   *  size, custom tone overrides (e.g. session unread state). */
  className?: string;
};

type TabPillProps = TabPillPropsBase &
  (
    | {
        /** When provided, the icon slot becomes a close button; the icon
         *  crossfades to X on hover. */
        onClose: () => void;
        /** ARIA label for the close button. Required when `onClose` is provided. */
        closeAriaLabel: string;
      }
    | {
        onClose?: never;
        closeAriaLabel?: never;
      }
  );

export function TabPill({
  active,
  icon,
  onSelect,
  onClose,
  closeAriaLabel,
  children,
  onTitleKeyDown,
  titleTabIndex,
  titleRef,
  className,
}: TabPillProps) {
  return (
    <div
      className={cn(
        "group flex h-7 items-center rounded-lg text-sm font-normal whitespace-nowrap transition-colors duration-150 select-none",
        active
          ? "bg-bg-raised text-text-secondary font-medium"
          : "text-text-muted hover:bg-control-hover hover:text-text-tertiary",
        className
      )}
    >
      {onClose ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={closeAriaLabel}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "control-interaction relative flex h-full w-7 shrink-0 cursor-pointer items-center justify-center rounded-l-lg border-none bg-transparent p-0",
            "hover:bg-control-hover active:bg-control-pressed"
          )}
        >
          <span className="absolute inset-0 grid place-items-center transition-opacity duration-150 group-hover:opacity-0">
            {icon}
          </span>
          <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </span>
        </button>
      ) : (
        <span className="flex h-full w-7 shrink-0 items-center justify-center">{icon}</span>
      )}
      <button
        ref={titleRef}
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={titleTabIndex}
        onClick={onSelect}
        onKeyDown={onTitleKeyDown}
        className="control-interaction active:bg-control-pressed flex h-full min-w-0 flex-1 cursor-pointer items-center rounded-r-lg border-none bg-transparent pr-2.5 pl-0.5 text-left text-inherit"
      >
        <span className="block truncate">{children}</span>
      </button>
    </div>
  );
}
