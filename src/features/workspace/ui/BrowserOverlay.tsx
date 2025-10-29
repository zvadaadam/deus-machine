import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrowserPanel } from '@/features/browser';
import { cn } from '@/shared/lib/utils';

interface BrowserOverlayProps {
  isOpen: boolean;
  workspaceId: string;
  onClose: () => void;
}

/**
 * BrowserOverlay - Floating overlay that slides in from the right
 *
 * Architecture:
 * - Uses React Portal to render outside normal DOM hierarchy
 * - Positioned as fixed overlay on the right side
 * - Covers the right panel (Changes/Terminal) when open
 * - Slides in/out with smooth animations
 * - Width: 400px (same as right panel for seamless coverage)
 *
 * Design Philosophy:
 * - Decoupled from core layout (portal pattern)
 * - Optional per workspace (conditionally rendered)
 * - Doesn't interfere with layout grid calculations
 * - Clean separation of concerns
 */
export function BrowserOverlay({ isOpen, workspaceId, onClose }: BrowserOverlayProps) {
  const [mounted, setMounted] = useState(false);

  // Ensure portal container exists
  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Don't render anything on server-side or before mount
  if (!mounted) return null;

  const overlay = (
    <div
      className={cn(
        'fixed top-0 right-0 bottom-0 z-50',
        'w-[400px]',
        'bg-background/95 backdrop-blur-xl',
        'border-l border-border',
        'shadow-[-20px_0_60px_rgba(0,0,0,0.3)]',
        'flex flex-col',
        'transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]',
        'motion-reduce:transition-none',
        isOpen ? 'translate-x-0' : 'translate-x-full'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-end p-4 border-b border-border bg-background/50 backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-8 w-8"
          title="Close browser"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Browser Panel Content */}
      <div className="flex-1 overflow-hidden">
        <BrowserPanel workspaceId={workspaceId} />
      </div>
    </div>
  );

  // Render as portal to body
  return createPortal(overlay, document.body);
}
