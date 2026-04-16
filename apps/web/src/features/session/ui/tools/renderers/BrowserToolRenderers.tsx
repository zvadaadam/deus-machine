/**
 * Browser MCP Tool Renderers
 *
 * Specialized renderers for the 13 Deus browser automation tools.
 * Groups related tools that share similar output patterns (snapshot-based,
 * action confirmations, data inspection).
 *
 * Tool categories:
 * - Navigation: BrowserNavigate, BrowserNavigateBack
 * - Interaction: BrowserClick, BrowserType, BrowserHover, BrowserSelectOption, BrowserPressKey
 * - Inspection: BrowserSnapshot, BrowserScreenshot, BrowserEvaluate
 * - Monitoring: BrowserConsoleMessages, BrowserNetworkRequests
 * - Flow: BrowserWaitFor
 */

import {
  Globe,
  MousePointerClick,
  Keyboard,
  Compass,
  Clock,
  Code2,
  Hand,
  ListChecks,
  ArrowLeft,
  MessageSquare,
  Camera,
  Network,
  Eye,
  ArrowDownUp,
} from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import { extractImage, extractText, OutputBlock, ICON_CLS } from "./shared";
import type { ToolRendererProps } from "../../chat-types";

/** Truncate a domain from URL for preview */
function getDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace("www.", "") + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url.length > 40 ? url.slice(0, 40) + "..." : url;
  }
}

// ---------------------------------------------------------------------------
// BrowserSnapshot
// ---------------------------------------------------------------------------

export function BrowserSnapshotToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const text = toolResult ? extractText(toolResult.content) : "";
  // Extract URL from output header (format: "- Page URL: https://...")
  const urlMatch = text.match(/Page URL:\s*(.+)/);
  const url = urlMatch?.[1]?.trim();

  return (
    <BaseToolRenderer
      toolName="Browser Snapshot"
      icon={<Eye className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        url ? (
          <span className="text-muted-foreground truncate font-mono">{getDomain(url)}</span>
        ) : null
      }
      renderContent={() =>
        text ? (
          <OutputBlock>{text}</OutputBlock>
        ) : (
          <div className="text-muted-foreground px-2 pb-2 text-xs italic">No snapshot captured</div>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserNavigate
// ---------------------------------------------------------------------------

export function BrowserNavigateToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { url } = toolUse.input ?? {};
  const text = toolResult ? extractText(toolResult.content) : "";

  return (
    <BaseToolRenderer
      toolName="Browser Navigate"
      icon={<Compass className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        url ? (
          <span className="text-muted-foreground truncate font-mono">{getDomain(url)}</span>
        ) : null
      }
      renderContent={() =>
        text ? (
          <OutputBlock>{text}</OutputBlock>
        ) : (
          <div className="text-muted-foreground px-2 pb-2 text-xs italic">Navigating...</div>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserNavigateBack
// ---------------------------------------------------------------------------

export function BrowserNavigateBackToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const text = toolResult ? extractText(toolResult.content) : "";

  return (
    <BaseToolRenderer
      toolName="Browser Back"
      icon={<ArrowLeft className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => <span className="text-muted-foreground">Go back</span>}
      renderContent={() => (text ? <OutputBlock>{text}</OutputBlock> : null)}
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserClick
// ---------------------------------------------------------------------------

export function BrowserClickToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { ref, doubleClick } = toolUse.input ?? {};
  const text = toolResult ? extractText(toolResult.content) : "";

  return (
    <BaseToolRenderer
      toolName={doubleClick ? "Browser Double Click" : "Browser Click"}
      icon={<MousePointerClick className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        ref ? <span className="text-muted-foreground truncate font-mono">{ref}</span> : null
      }
      renderContent={() => (text ? <OutputBlock>{text}</OutputBlock> : null)}
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserType
// ---------------------------------------------------------------------------

export function BrowserTypeToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { ref, text: typedText, submit } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const preview = typedText
    ? typedText.length > 30
      ? `"${typedText.slice(0, 30)}..."`
      : `"${typedText}"`
    : "";

  return (
    <BaseToolRenderer
      toolName="Browser Type"
      icon={<Keyboard className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <>
          {ref && <span className="text-muted-foreground truncate font-mono">{ref}</span>}
          {preview && (
            <span className="text-muted-foreground truncate">
              {submit ? `${preview} ⏎` : preview}
            </span>
          )}
        </>
      )}
      renderContent={() => (output ? <OutputBlock>{output}</OutputBlock> : null)}
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserPressKey
// ---------------------------------------------------------------------------

export function BrowserPressKeyToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { key, ctrl, shift, alt, meta } = toolUse.input ?? {};
  const modifiers = [meta && "⌘", ctrl && "Ctrl", alt && "Alt", shift && "⇧"]
    .filter(Boolean)
    .join("+");
  const combo = modifiers ? `${modifiers}+${key}` : key;

  return (
    <BaseToolRenderer
      toolName="Browser Press Key"
      icon={<Keyboard className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        combo ? (
          <span className="bg-muted/60 text-muted-foreground rounded-md px-1.5 py-0.5 font-mono">
            {combo}
          </span>
        ) : null
      }
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserHover
// ---------------------------------------------------------------------------

export function BrowserHoverToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { element, ref } = toolUse.input ?? {};
  const text = toolResult ? extractText(toolResult.content) : "";

  return (
    <BaseToolRenderer
      toolName="Browser Hover"
      icon={<Hand className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        element ? (
          <span className="text-muted-foreground truncate">{element}</span>
        ) : ref ? (
          <span className="text-muted-foreground truncate font-mono">{ref}</span>
        ) : null
      }
      renderContent={() => (text ? <OutputBlock>{text}</OutputBlock> : null)}
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserSelectOption
// ---------------------------------------------------------------------------

export function BrowserSelectOptionToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { element, values } = toolUse.input ?? {};
  const text = toolResult ? extractText(toolResult.content) : "";
  const valuesPreview = Array.isArray(values) ? values.join(", ") : "";

  return (
    <BaseToolRenderer
      toolName="Browser Select"
      icon={<ListChecks className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <>
          {element && <span className="text-muted-foreground truncate">{element}</span>}
          {valuesPreview && (
            <span className="text-muted-foreground truncate font-mono">→ {valuesPreview}</span>
          )}
        </>
      )}
      renderContent={() => (text ? <OutputBlock>{text}</OutputBlock> : null)}
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserWaitFor
// ---------------------------------------------------------------------------

export function BrowserWaitForToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { text: waitText, textGone, time } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const condition = waitText
    ? `text: "${waitText}"`
    : textGone
      ? `gone: "${textGone}"`
      : time
        ? `${time}s`
        : "...";

  return (
    <BaseToolRenderer
      toolName="Browser Wait"
      icon={<Clock className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => <span className="text-muted-foreground truncate">{condition}</span>}
      renderContent={() => (output ? <OutputBlock>{output}</OutputBlock> : null)}
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserEvaluate
// ---------------------------------------------------------------------------

export function BrowserEvaluateToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { code } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const codePreview =
    typeof code === "string" ? (code.length > 40 ? code.slice(0, 40) + "..." : code) : "";

  return (
    <BaseToolRenderer
      toolName="Browser Evaluate"
      icon={<Code2 className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        codePreview ? (
          <span className="text-muted-foreground truncate font-mono">{codePreview}</span>
        ) : null
      }
      renderContent={() => (
        <div className="space-y-2">
          {code && (
            <pre
              className={cn(
                "overflow-x-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap",
                "chat-scroll-contain max-h-[200px] overflow-y-auto border",
                "bg-muted/50 text-foreground border-border/60"
              )}
            >
              <code>{code}</code>
            </pre>
          )}
          {output && <OutputBlock>{output}</OutputBlock>}
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserConsoleMessages
// ---------------------------------------------------------------------------

export function BrowserConsoleMessagesToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const text = toolResult ? extractText(toolResult.content) : "";
  const countMatch = text.match(/\((\d+)\)/);
  const count = countMatch?.[1];

  return (
    <BaseToolRenderer
      toolName="Browser Console"
      icon={<MessageSquare className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        count ? <span className="text-muted-foreground">{count} messages</span> : null
      }
      renderContent={() =>
        text ? (
          <OutputBlock>{text}</OutputBlock>
        ) : (
          <div className="text-muted-foreground px-2 pb-2 text-xs italic">No console messages</div>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserScreenshot
// ---------------------------------------------------------------------------

export function BrowserScreenshotToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const image = toolResult ? extractImage(toolResult.content) : null;
  const text = toolResult ? extractText(toolResult.content) : "";

  return (
    <BaseToolRenderer
      toolName="Browser Screenshot"
      icon={<Camera className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={!!image}
      renderSummary={() =>
        text ? <span className="text-muted-foreground truncate">{text.slice(0, 60)}</span> : null
      }
      renderContent={() => (
        <div className="space-y-2">
          {image && (
            <img
              src={`data:${image.mediaType};base64,${image.data}`}
              alt="Browser screenshot"
              className="border-border/40 max-w-full rounded-lg border shadow-sm"
            />
          )}
          {text && !image && (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">{text}</div>
          )}
        </div>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserNetworkRequests
// ---------------------------------------------------------------------------

export function BrowserNetworkRequestsToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const text = toolResult ? extractText(toolResult.content) : "";
  const countMatch = text.match(/\((\d+)\)/);
  const count = countMatch?.[1];

  return (
    <BaseToolRenderer
      toolName="Browser Network"
      icon={<Network className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        count ? <span className="text-muted-foreground">{count} requests</span> : null
      }
      renderContent={() =>
        text ? (
          <OutputBlock>{text}</OutputBlock>
        ) : (
          <div className="text-muted-foreground px-2 pb-2 text-xs italic">No network requests</div>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// BrowserScroll
// ---------------------------------------------------------------------------

export function BrowserScrollToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { direction, amount, ref } = toolUse.input ?? {};
  const text = toolResult ? extractText(toolResult.content) : "";
  const summary = ref ? `→ ${ref}` : `${direction ?? "down"} ${amount ?? 600}px`;

  return (
    <BaseToolRenderer
      toolName="Browser Scroll"
      icon={<ArrowDownUp className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => <span className="text-muted-foreground truncate">{summary}</span>}
      renderContent={() => (text ? <OutputBlock>{text}</OutputBlock> : null)}
    />
  );
}
