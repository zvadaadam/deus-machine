/**
 * TabPill — shared primitive for Browser/Session/Terminal tab bars.
 *
 * Layout: [icon-slot][title]. The icon slot shows the supplied icon at rest;
 * when `onClose` is provided, the slot becomes a button that crossfades to
 * an X on tab hover (skill: Contextual Icon Animations — scale 0.25→1,
 * opacity 0→1, blur 4px→0; both icons stay in the DOM so enter+exit animate
 * without a motion library).
 *
 * Click the title button to select; click the icon slot (when closable) to
 * close. The component sets role="tab" + aria-selected on the title button,
 * so callers should wrap it in a role="tablist" container.
 */

import type { KeyboardEvent, ReactNode, RefCallback } from "react";
import { X } from "lucide-react";
import { cn } from "@/shared/lib/utils";

const ICON_CROSS_FADE =
  "transition-[opacity,filter,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";

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
        "group flex h-7 items-center rounded-md text-xs whitespace-nowrap transition-colors duration-200 ease-out select-none",
        active
          ? "bg-bg-raised text-text-secondary font-medium"
          : "text-text-muted hover:bg-foreground/5 hover:text-text-tertiary",
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
            "relative flex h-full w-7 shrink-0 cursor-pointer items-center justify-center rounded-l-md border-none bg-transparent p-0",
            "transition-[background-color,scale] duration-150 ease-out",
            "hover:bg-foreground/10 active:scale-[0.96]"
          )}
        >
          <span
            className={cn(
              "absolute inset-0 grid place-items-center",
              ICON_CROSS_FADE,
              "group-hover:scale-[0.25] group-hover:opacity-0 group-hover:blur-[4px]"
            )}
          >
            {icon}
          </span>
          <span
            className={cn(
              "absolute inset-0 grid scale-[0.25] place-items-center opacity-0 blur-[4px]",
              ICON_CROSS_FADE,
              "group-hover:scale-100 group-hover:opacity-100 group-hover:blur-none"
            )}
          >
            <X strokeWidth={1.75} className="h-3.5 w-3.5" />
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
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center border-none bg-transparent pr-2.5 pl-0.5 text-left text-inherit"
      >
        <span className="block truncate">{children}</span>
      </button>
    </div>
  );
}
