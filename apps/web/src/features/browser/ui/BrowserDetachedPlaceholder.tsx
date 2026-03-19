/**
 * Shown in the main window's right side panel when the browser
 * has been popped out into a separate OS window.
 */

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BrowserDetachedPlaceholderProps {
  onReattach: () => void;
}

export function BrowserDetachedPlaceholder({ onReattach }: BrowserDetachedPlaceholderProps) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3">
      <ExternalLink className="h-8 w-8 opacity-30" />
      <p className="text-sm">Browser is in a separate window</p>
      <Button variant="outline" size="sm" onClick={onReattach}>
        Bring Back
      </Button>
    </div>
  );
}
