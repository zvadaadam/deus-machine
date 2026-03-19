import * as React from "react";

import { cn } from "@/shared/lib/utils";

// Some engines don't support field-sizing: content.
// Detect once so we can fall back to JS-based auto-resize.
const supportsFieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<"textarea">>(
  ({ className, ...props }, forwardedRef) => {
    const internalRef = React.useRef<HTMLTextAreaElement | null>(null);

    const setRef = React.useCallback(
      (el: HTMLTextAreaElement | null) => {
        internalRef.current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      },
      [forwardedRef]
    );

    const resize = React.useCallback(() => {
      if (supportsFieldSizing) return;
      const el = internalRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, []);

    // Resize on controlled value changes + mount
    React.useLayoutEffect(() => {
      resize();
    }, [props.value, resize]);

    // Handle uncontrolled textareas via native "input" event
    React.useEffect(() => {
      if (supportsFieldSizing) return;
      const el = internalRef.current;
      if (!el) return;
      el.addEventListener("input", resize);
      return () => el.removeEventListener("input", resize);
    }, [resize]);

    return (
      <textarea
        data-slot="textarea"
        className={cn(
          "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive-ring aria-invalid:border-destructive bg-input-tint flex field-sizing-content min-h-16 w-full rounded-lg border px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        {...props}
        ref={setRef}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
