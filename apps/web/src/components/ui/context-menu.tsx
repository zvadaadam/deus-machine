import * as Menu from "@radix-ui/react-context-menu";
import { ChevronRight } from "lucide-react";
import type { ComponentProps, KeyboardEvent, ReactElement, ReactNode } from "react";
import { DropdownMenuGlide } from "./dropdown-menu";

const contentClass =
  "bg-popover text-popover-foreground relative isolate z-50 min-w-40 overflow-y-auto rounded-xl border p-1 shadow-md max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) data-[state=open]:animate-[dropdown-enter_var(--tempo-moderate)_var(--tempo-ease)] data-[state=closed]:animate-[dropdown-exit_var(--tempo-moderate-exit)_var(--tempo-ease)]";
const itemClass =
  "focus:text-accent-foreground flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none [&_svg]:text-muted-foreground [&_svg]:size-4";

function openFromKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  const { left, bottom } = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: left,
      clientY: bottom,
    })
  );
}

export function ContextMenu({ trigger, children }: { trigger: ReactElement; children: ReactNode }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild onKeyDown={openFromKeyboard}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className={contentClass}>
          <DropdownMenuGlide />
          {children}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function ContextMenuItem(props: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={itemClass} {...props} />;
}

export function ContextMenuSub({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Menu.Sub>
      <Menu.SubTrigger className={`${itemClass} data-[state=open]:bg-accent`}>
        {label}
        <ChevronRight className="ml-auto" />
      </Menu.SubTrigger>
      <Menu.Portal>
        <Menu.SubContent className={contentClass}>
          <DropdownMenuGlide />
          {children}
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  );
}
