import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../apps/web/src");
const exceptions: Record<string, RegExp> = {
  "global.css":
    /shimmer 2s ease-in-out infinite|subtle-spin 2s linear infinite|tool-shimmer 2s linear infinite/g, // Initialization, spinner, pending tool.
  "features/auth/ui/PairGatePage.tsx":
    /animate-\[pair-pulse_[^\]]+_infinite\]|type: "spring", stiffness: 300, damping: 20/g, // Waiting dots and the pairing success mark's overshoot.
  "features/connection/ui/ServerOfflinePage.tsx": /animate-\[waiting-dot_[^\]]+_infinite\]/g, // Waiting for a computer.
  "features/session/ui/blocks/StreamingReasoningBlock.tsx":
    /animate-\[reasoning-pulse_[^\]]+_infinite_alternate\]/g, // Live reasoning.
  "features/browser/ui/BrowserTab.tsx":
    /animate-\[browser-loading(?:-complete)?_[^\]]+_forwards\]/g, // Navigation progress.
};
const utility =
  /\b(?:duration-[\w[(]|ease-(?!move\b)[\w[(]|transition-all\b)|(?:animate-\[|\[[\w-]*(?:duration|delay):)[^\]]*\d(?:ms|s)(?=[^a-z])/;
const tokens = /^\s*--(?:ease-move|tempo-(?:(?:fast|moderate|slow)(?:-exit)?|ease|step)):/;
const cssTiming = /\b(?:easing|(?:transition|animation)(?:Duration|TimingFunction)?)\s*[:=]/;
const rawCssValue = /\d(?:ms|s)\b|(?:^|[\s"'_])(?:ease|linear|step-start|step-end)(?=$|[\s"',;_])/;
const motionTiming =
  /(?:^|[{,])\s*(?:(?:ease|stiffness|damping)\s*:|type\s*:\s*["']spring["']|duration\s*:\s*(?:0?\.\d|\d{1,2}\b))/;
const webTiming =
  /\.animate\((?:[^();]|\([^();]*\))*?,\s*(?:[+-]?[\d.][\w.+-]*|\{[^{};]*\bduration\s*:\s*[+-]?[\d.][^{};]*\})\s*,?\s*\)/g;
const guidance =
  "Use bare transitions for fast controls, tempo-moderate/slow for surfaces, ease-move for layout, or tempo.<tier>[.exit] in Framer Motion.";

it("uses tempo for interface transitions", () => {
  const errors: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const file = entry.split(path.sep).join("/");
    if (!/\.(?:css|[jt]sx?)$/.test(file) || file === "shared/lib/tempo.ts") continue;
    // Guest scripts draw recording choreography on visited pages, outside the Deus UI.
    if (file.startsWith("features/browser/automation/inject/")) continue;
    let src = readFileSync(path.join(root, entry), "utf8");
    src = src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, (comment) => comment.replace(/[^\n]/g, ""));
    if (exceptions[file]) src = src.replace(exceptions[file], "");
    for (const match of src.matchAll(webTiming)) {
      errors.push(`${file}:${src.slice(0, match.index).split("\n").length}  ${match[0]}`);
    }
    const framer = /from ["'](?:framer-motion|motion\/react)["']/.test(src);
    src.split("\n").forEach((line, i) => {
      if (file === "global.css" && tokens.test(line)) return;
      // A toast's lifetime and the duration field of a media type are data.
      const motion =
        motionTiming.test(line) || (framer && /\bduration\s*:(?!\s*number\b)/.test(line));
      const css = (file.endsWith(".css") || cssTiming.test(line)) && rawCssValue.test(line);
      if (utility.test(line) || motion || css || /\b(?:cubic-bezier|steps)\(/.test(line)) {
        errors.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  expect(errors, guidance).toEqual([]);
});

it("preserves the standard backdrop-filter in production", () => {
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".css")) continue;
    const css = readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const prefixLast = /[;{]\s*-webkit-backdrop-filter\s*:(?![^{}]*;\s*backdrop-filter\s*:)/i;
    expect(prefixLast.test(css), `${file}: write backdrop-filter alone.`).toBe(false);
  }
});
