import { useRef, type ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { FileViewer } from "./FileViewer";

export function FileViewerSheet({
  open,
  close,
  workspaceId,
  name,
  path,
  archived,
  action,
}: {
  open: boolean;
  close: () => void;
  workspaceId: string;
  name: string;
  path?: string | null;
  archived?: boolean;
  action?: ReactNode;
}) {
  const trigger = useRef<HTMLElement | null>(null);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          trigger.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus({ preventScroll: true });
        }}
        className="w-full gap-0 border-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:max-w-none [&>button]:top-[env(safe-area-inset-top)] [&>button]:right-1 [&>button]:size-11"
      >
        {path && (
          <FileViewer
            key={path}
            workspaceId={workspaceId}
            filePath={path}
            workspaceName={name}
            header={(hasCheckout) => (
              <div className="border-border-subtle flex h-11 shrink-0 items-center gap-2 border-b pr-14 pl-4">
                <SheetTitle className="min-w-0 truncate text-sm">
                  {name}
                  {archived && " · archived"}
                </SheetTitle>
                {hasCheckout && action}
              </div>
            )}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
