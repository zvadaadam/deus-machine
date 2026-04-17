import {
  ArrowDownUp,
  Camera,
  FolderSearch,
  Keyboard,
  MousePointerClick,
  Play,
  Rocket,
  ScanEye,
  Smartphone,
  Timer,
} from "lucide-react";
import { BaseToolRenderer } from "../components";
import { extractImage, extractText, ICON_CLS, OutputBlock } from "./shared";
import type { ToolRendererProps } from "../../chat-types";
import { getPathLeaf } from "../utils/getPathLeaf";

function truncate(value: string, maxLength = 36): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function renderOutput(output: string, emptyLabel: string) {
  if (!output) {
    return <div className="text-muted-foreground px-2 pb-2 text-xs italic">{emptyLabel}</div>;
  }
  return <OutputBlock>{output}</OutputBlock>;
}

function renderWithImage({
  toolResult,
  emptyLabel,
}: {
  toolResult?: ToolRendererProps["toolResult"];
  emptyLabel: string;
}) {
  const image = toolResult ? extractImage(toolResult.content) : null;
  const output = toolResult ? extractText(toolResult.content) : "";

  return (
    <div className="space-y-2">
      {image && (
        <div className="bg-muted/40 flex items-center justify-center rounded-xl p-5">
          <img
            src={`data:${image.mediaType};base64,${image.data}`}
            alt="Simulator screenshot"
            className="max-h-80 w-auto rounded-lg shadow-sm"
          />
        </div>
      )}
      {output ? (
        <OutputBlock>{output}</OutputBlock>
      ) : (
        !image && <div className="text-muted-foreground px-2 pb-2 text-xs italic">{emptyLabel}</div>
      )}
    </div>
  );
}

// -- Screenshot ---------------------------------------------------------------

export function XcodeMcpScreenshotToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  // Built-in SimulatorScreenshot tool uses `format`; xcode-mcp uses `type` — accept both.
  const input = (toolUse.input ?? {}) as { format?: unknown; type?: unknown };
  const format =
    typeof input.format === "string"
      ? input.format
      : typeof input.type === "string"
        ? input.type
        : undefined;

  return (
    <BaseToolRenderer
      toolName="Simulator Screenshot"
      icon={<Camera className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        format ? <span className="text-muted-foreground">{format}</span> : null
      }
      renderContent={() => renderWithImage({ toolResult, emptyLabel: "No screenshot captured" })}
    />
  );
}

// -- Tap ----------------------------------------------------------------------

export function XcodeMcpTapToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { ref, identifier, x, y, label, longPress, doubleTap } = toolUse.input ?? {};
  const safeRef = typeof ref === "string" ? ref : "";
  const safeId = typeof identifier === "string" ? truncate(identifier, 30) : "";
  const safeLabel = typeof label === "string" ? truncate(label, 30) : "";
  const hasCoords = typeof x === "number" && typeof y === "number";
  const flags = [longPress && "long", doubleTap && "double"].filter(Boolean).join(", ");

  return (
    <BaseToolRenderer
      toolName="Simulator Tap"
      icon={<MousePointerClick className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        safeRef ? (
          <span className="text-muted-foreground font-mono">
            {safeRef}
            {flags ? ` (${flags})` : ""}
          </span>
        ) : safeId ? (
          <span className="text-muted-foreground truncate font-mono">
            #{safeId}
            {flags ? ` (${flags})` : ""}
          </span>
        ) : safeLabel ? (
          <span className="text-muted-foreground truncate">
            "{safeLabel}"{flags ? ` (${flags})` : ""}
          </span>
        ) : hasCoords ? (
          <span className="text-muted-foreground font-mono">
            {x}, {y}
            {flags ? ` (${flags})` : ""}
          </span>
        ) : null
      }
      renderContent={() => renderWithImage({ toolResult, emptyLabel: "Tap sent" })}
    />
  );
}

// -- Type Text ----------------------------------------------------------------

export function XcodeMcpTypeTextToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { text, clearFirst, submit, slowly } = toolUse.input ?? {};
  const safeText = typeof text === "string" ? truncate(text, 30) : "";
  const flags = [clearFirst && "clear", submit && "submit", slowly && "slow"]
    .filter(Boolean)
    .join(", ");

  return (
    <BaseToolRenderer
      toolName="Simulator Type"
      icon={<Keyboard className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        safeText ? (
          <span className="text-muted-foreground truncate">
            "{safeText}"{flags ? ` (${flags})` : ""}
          </span>
        ) : null
      }
      renderContent={() => renderWithImage({ toolResult, emptyLabel: "Typing text..." })}
    />
  );
}

// -- Swipe --------------------------------------------------------------------

export function XcodeMcpSwipeToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { direction, startX, startY, endX, endY } = toolUse.input ?? {};
  const dirArrow: Record<string, string> = {
    up: "\u2191",
    down: "\u2193",
    left: "\u2190",
    right: "\u2192",
  };
  const safeDir = typeof direction === "string" ? direction : "";

  return (
    <BaseToolRenderer
      toolName="Simulator Swipe"
      icon={<ArrowDownUp className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        safeDir ? (
          <span className="text-muted-foreground">
            {dirArrow[safeDir] ?? ""} {safeDir}
          </span>
        ) : typeof startX === "number" ? (
          <span className="text-muted-foreground font-mono">
            {startX},{startY} → {endX},{endY}
          </span>
        ) : null
      }
      renderContent={() => renderWithImage({ toolResult, emptyLabel: "Swipe sent" })}
    />
  );
}

// -- Press Key ----------------------------------------------------------------

export function XcodeMcpPressKeyToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { key } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const safeKey = typeof key === "string" ? key : "";

  return (
    <BaseToolRenderer
      toolName="Simulator Key"
      icon={<Keyboard className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        safeKey ? <span className="text-muted-foreground font-mono">{safeKey}</span> : null
      }
      renderContent={() => renderOutput(output, "Key sent")}
    />
  );
}

// -- Build --------------------------------------------------------------------

export function XcodeMcpBuildToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { scheme, workingDirectory } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const label =
    typeof scheme === "string"
      ? scheme
      : typeof workingDirectory === "string"
        ? getPathLeaf(workingDirectory)
        : "";

  return (
    <BaseToolRenderer
      toolName="Xcode Build"
      icon={<Rocket className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        label ? <span className="text-muted-foreground truncate font-mono">{label}</span> : null
      }
      renderContent={() => renderOutput(output, "Building...")}
    />
  );
}

// -- Launch -------------------------------------------------------------------

export function XcodeMcpLaunchToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { bundleId } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const safeBundleId = typeof bundleId === "string" ? truncate(bundleId, 40) : "";

  return (
    <BaseToolRenderer
      toolName="Launch App"
      icon={<Play className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        safeBundleId ? (
          <span className="text-muted-foreground truncate font-mono">{safeBundleId}</span>
        ) : null
      }
      renderContent={() => renderOutput(output, "Launching...")}
    />
  );
}

// -- Read Screen --------------------------------------------------------------

export function XcodeMcpReadScreenToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { filter } = toolUse.input ?? {};
  const safeFilter = typeof filter === "string" ? filter : "";

  return (
    <BaseToolRenderer
      toolName="Read Screen"
      icon={<ScanEye className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        safeFilter ? <span className="text-muted-foreground">{safeFilter}</span> : null
      }
      renderContent={() => renderWithImage({ toolResult, emptyLabel: "Reading screen..." })}
    />
  );
}

// -- Wait For -----------------------------------------------------------------

export function XcodeMcpWaitForToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { time, stabilize } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const label = typeof time === "number" ? `${time}s` : stabilize ? "stabilize" : "";

  return (
    <BaseToolRenderer
      toolName="Wait"
      icon={<Timer className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (label ? <span className="text-muted-foreground">{label}</span> : null)}
      renderContent={() => renderOutput(output, "Waiting...")}
    />
  );
}

// -- Get Project Info ---------------------------------------------------------

export function XcodeMcpGetProjectInfoToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { workingDirectory } = toolUse.input ?? {};
  const output = toolResult ? extractText(toolResult.content) : "";
  const label = typeof workingDirectory === "string" ? getPathLeaf(workingDirectory) : "";

  return (
    <BaseToolRenderer
      toolName="Xcode Project Info"
      icon={<FolderSearch className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        label ? <span className="text-muted-foreground truncate font-mono">{label}</span> : null
      }
      renderContent={() => renderOutput(output, "Loading project info...")}
    />
  );
}

// -- Refresh Destinations -----------------------------------------------------

export function XcodeMcpRefreshDestinationsToolRenderer({
  toolUse,
  toolResult,
}: ToolRendererProps) {
  const output = toolResult ? extractText(toolResult.content) : "";

  return (
    <BaseToolRenderer
      toolName="Refresh Destinations"
      icon={<Smartphone className={ICON_CLS} />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => null}
      renderContent={() => renderOutput(output, "Refreshing...")}
    />
  );
}
