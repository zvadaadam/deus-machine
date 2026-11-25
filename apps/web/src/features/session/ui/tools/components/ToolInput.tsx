import { useMemo } from "react";
import type { ToolUseBlock } from "../types";

type InputProps = Pick<ToolUseBlock, "input">;

export function ToolInput({ input }: InputProps) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-xs font-semibold">Input:</div>
      <pre className="bg-muted/60 border-border/60 chat-scroll-contain max-h-[200px] overflow-x-auto overflow-y-auto rounded-lg border p-3 font-mono text-xs">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

export function ToolInputSummary({ input }: InputProps) {
  const preview = useMemo(() => {
    const values = Object.values(input);
    const value = values.find((entry) => entry != null && typeof entry !== "object") ?? values[0];
    // A patch can be megabytes. Preview its shape without serializing the payload.
    if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`.slice(0, 40);
    }
    return String(value ?? "").slice(0, 40);
  }, [input]);
  return (
    preview && <span className="text-muted-foreground truncate font-mono text-sm">{preview}</span>
  );
}
