/**
 * User bubble — iMessage-style, right-aligned, with copy and collapse for long text.
 */

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/shared/lib/utils";
import { useCopyToClipboard } from "@/shared/hooks";
import { ActionButton } from "./ActionButton";
import { TextBlock } from "./blocks/TextBlock";

const COLLAPSE_MAX_HEIGHT = 144;

export const UserBubble = memo(function UserBubble({
  id,
  texts,
  images = [],
  caption,
}: {
  id: string;
  texts: string[];
  images?: string[];
  /** Who sent it, when that is not the person using the app. */
  caption?: ReactNode;
}) {
  const { copy, copied } = useCopyToClipboard();
  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldCollapse, setShouldCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasTextContent = texts.length > 0;

  useEffect(() => {
    if (contentRef.current) {
      setShouldCollapse(contentRef.current.scrollHeight > COLLAPSE_MAX_HEIGHT);
    }
  }, [images, texts]);

  const handleCopy = () => copy(texts.join("\n"));

  return (
    <div className="group relative flex flex-col items-end">
      {caption && (
        <div className="text-text-tertiary mb-1 flex max-w-[85%] items-center gap-1.5 text-xs">
          {caption}
        </div>
      )}
      <div
        className={cn(
          "max-w-[85%]",
          "bg-accent hover:bg-accent/80 ml-auto w-fit backdrop-blur-sm transition-colors duration-200 ease-out motion-reduce:transition-none",
          "relative rounded-xl",
          "px-3 py-2",
          "min-w-0"
        )}
      >
        <div className="pointer-events-none absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity duration-200 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          <ActionButton
            icon={Copy}
            label={copied ? "Copied" : "Copy"}
            onClick={handleCopy}
            active={copied}
            showLabel={false}
            className="bg-accent/80 rounded-md backdrop-blur-sm"
          />
        </div>

        {images.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", hasTextContent && "mb-2")}>
            {images.map((src, idx) => (
              <div
                key={`${id}:img:${idx}`}
                className="border-border/60 h-[80px] w-[80px] shrink-0 overflow-hidden rounded-lg border"
              >
                <img src={src} alt="Pasted image" className="h-full w-full object-cover" />
              </div>
            ))}
          </div>
        )}

        {hasTextContent && (
          <motion.div
            ref={contentRef}
            id={`message-content-${id}`}
            className="relative min-w-0 overflow-hidden"
            animate={
              shouldCollapse
                ? { height: isExpanded ? "auto" : COLLAPSE_MAX_HEIGHT }
                : { height: "auto" }
            }
            initial={false}
            transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
          >
            {texts.map((text, idx) => (
              <TextBlock key={`${id}:text:${idx}`} block={text} role="user" />
            ))}

            {shouldCollapse && !isExpanded && (
              <div className="from-accent via-accent/60 pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-t to-transparent" />
            )}
          </motion.div>
        )}

        {shouldCollapse && (
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1 text-xs font-normal transition-colors duration-200"
            aria-expanded={isExpanded}
            aria-controls={`message-content-${id}`}
          >
            {isExpanded ? (
              <>
                Show less
                <ChevronUp className="h-3 w-3" />
              </>
            ) : (
              <>
                Show more
                <ChevronDown className="h-3 w-3" />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
});
