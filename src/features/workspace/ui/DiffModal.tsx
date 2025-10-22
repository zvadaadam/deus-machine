import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface DiffModalProps {
  selectedFile: string | null;
  fileDiff: string;
  loading: boolean;
  onClose: () => void;
}

/**
 * Modal for displaying git diff for a specific file
 * Shows unified diff format with syntax highlighting
 */
export function DiffModal({
  selectedFile,
  fileDiff,
  loading,
  onClose,
}: DiffModalProps) {
  return (
    <Dialog open={!!selectedFile} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[800px] max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Diff: {selectedFile}</DialogTitle>
        </DialogHeader>

        <ScrollArea className="h-[500px] w-full rounded-md border p-4">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Loading diff...
            </div>
          ) : (
            <pre className="text-sm font-mono whitespace-pre">{fileDiff}</pre>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
