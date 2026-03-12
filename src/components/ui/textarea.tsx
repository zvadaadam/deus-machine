import * as React from "react";

import { cn } from "@/shared/lib/utils";

// WebKit (Safari / Tauri WKWebView) doesn't support field-sizing: content.
// Detect once so we can fall back to JS-based auto-resize.
const supportsFieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  const ref = React.useRef<HTMLTextAreaElement>(null);

  // JS fallback: resize textarea height to fit content.
  // useLayoutEffect fires before paint — prevents visible height flicker.
  React.useLayoutEffect(() => {
    if (supportsFieldSizing) return;
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);

  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive-ring aria-invalid:border-destructive bg-input-tint flex field-sizing-content min-h-16 w-full rounded-lg border px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
      ref={ref}
    />
  );
}

export { Textarea };
