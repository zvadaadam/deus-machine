import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { FileViewer } from "./FileViewer";

interface SheetFile {
  workspaceId: string;
  name: string;
  path: string;
  archived?: boolean;
  onWorkspaceAction?: () => void;
  restoring?: boolean;
}

export function FileViewerSheet({ file, close }: { file?: SheetFile; close: () => void }) {
  const trigger = useRef<HTMLElement | null>(null);
  // Radix keeps the sheet mounted through its exit. Keep the same file on screen until then.
  const [last, setLast] = useState(file);
  if (file && file !== last) setLast(file);
  const shown = file ?? last;
  if (!shown) return null;
  const { workspaceId, name, path, archived, onWorkspaceAction, restoring } = shown;
  return (
    <Sheet
      open={!!file}
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
        <FileViewer
          key={workspaceId + ":" + path}
          workspaceId={workspaceId}
          filePath={path}
          workspaceName={name}
          header={(hasCheckout, recheckCheckout) => (
            <div className="border-border-subtle flex h-11 shrink-0 items-center gap-2 border-b pr-14 pl-4">
              <SheetTitle className="min-w-0 truncate text-sm">
                {name}
                {archived && " · archived"}
              </SheetTitle>
              {hasCheckout && onWorkspaceAction && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto shrink-0"
                  disabled={restoring}
                  onClick={async () => {
                    if (!archived || (await recheckCheckout())) onWorkspaceAction();
                  }}
                >
                  {archived ? "Restore workspace" : "Open in workspace"}
                </Button>
              )}
            </div>
          )}
        />
      </SheetContent>
    </Sheet>
  );
}
