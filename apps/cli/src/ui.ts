/**
 * Terminal UI primitives for the Deus CLI.
 *
 * Zero dependencies — uses raw ANSI escape codes so everything
 * bundles into a single file with esbuild. Inspired by Claude Code,
 * Vercel CLI, and create-next-app.
 */

// ── ANSI Colors ──────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

// Check NO_COLOR / FORCE_COLOR env vars (respect user preference)
const noColor = !!process.env.NO_COLOR || process.argv.includes("--no-color");

function wrap(code: string, text: string): string {
  if (noColor) return text;
  return `${ESC}${code}m${text}${RESET}`;
}

export const c = {
  // Modifiers
  bold: (t: string) => wrap("1", t),
  dim: (t: string) => wrap("2", t),
  italic: (t: string) => wrap("3", t),
  underline: (t: string) => wrap("4", t),

  // Colors
  red: (t: string) => wrap("31", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  blue: (t: string) => wrap("34", t),
  magenta: (t: string) => wrap("35", t),
  cyan: (t: string) => wrap("36", t),
  white: (t: string) => wrap("37", t),
  gray: (t: string) => wrap("90", t),

  // Bright colors
  brightCyan: (t: string) => wrap("96", t),
  brightWhite: (t: string) => wrap("97", t),

  // Backgrounds
  bgCyan: (t: string) => wrap("46", t),
  bgBlue: (t: string) => wrap("44", t),

  // Combo
  label: (t: string) => wrap("1;36", t), // bold cyan
};

// True-color (24-bit) foreground
function rgb(r: number, g: number, b: number, text: string): string {
  if (noColor) return text;
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

// ── Symbols ──────────────────────────────────────────────────────────

// Unicode symbols with ASCII fallbacks for limited terminals
const isUnicode = process.platform !== "win32" || !!process.env.WT_SESSION;

export const sym = {
  tick: isUnicode ? "✓" : "√",
  cross: isUnicode ? "✗" : "×",
  dot: isUnicode ? "●" : "*",
  dash: isUnicode ? "─" : "-",
  arrow: isUnicode ? "→" : "->",
  diamond: isUnicode ? "◆" : "*",
  pointer: isUnicode ? "❯" : ">",
  info: isUnicode ? "ℹ" : "i",
  warning: isUnicode ? "⚠" : "!",
  bullet: isUnicode ? "•" : "-",

  // Box drawing
  tl: isUnicode ? "╭" : "+",
  tr: isUnicode ? "╮" : "+",
  bl: isUnicode ? "╰" : "+",
  br: isUnicode ? "╯" : "+",
  h: isUnicode ? "─" : "-",
  v: isUnicode ? "│" : "|",
};

// ── Logo / Banner ────────────────────────────────────────────────────

// DEUS in block characters (ANSI Shadow style), per-letter for gradient coloring
const LOGO_D = ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "];
const LOGO_E = ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"];
const LOGO_U = ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "];
const LOGO_S = ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"];

const LETTERS = [LOGO_D, LOGO_E, LOGO_U, LOGO_S];

// Gradient for block chars (█): violet → indigo → blue → cyan
const LOGO_BLOCK: [number, number, number][] = [
  [167, 139, 250],
  [129, 140, 248],
  [96, 165, 250],
  [34, 211, 238],
];

// Shadow for border chars (╔═╗║╚╝) in rows 0-4
const LOGO_INNER: [number, number, number][] = [
  [100, 83, 150],
  [77, 84, 149],
  [58, 99, 150],
  [20, 127, 143],
];

// Extra-dim shadow for the bottom row (╚═╝)
const LOGO_FLOOR: [number, number, number][] = [
  [60, 50, 90],
  [46, 50, 89],
  [35, 59, 90],
  [12, 76, 86],
];

const SHADOW_CHARS = new Set("╔═╗║╚╝╬╠╣╦╩╓╖╙╜╒╕╘╛┌┐└┘┬┴├┤┼─│");

/** Color a logo row: block chars in main color, shadow chars in dim */
function colorLogo(
  text: string,
  block: [number, number, number],
  shadow: [number, number, number]
): string {
  let result = "";
  let buf = "";
  let cur: "b" | "s" | " " | null = null;

  function flush() {
    if (!buf) return;
    if (cur === "b") result += rgb(block[0], block[1], block[2], buf);
    else if (cur === "s") result += rgb(shadow[0], shadow[1], shadow[2], buf);
    else result += buf;
    buf = "";
  }

  for (const ch of text) {
    const t = ch === " " ? " " : SHADOW_CHARS.has(ch) ? "s" : "b";
    if (t !== cur) {
      flush();
      cur = t;
    }
    buf += ch;
  }
  flush();
  return result;
}

// ASCII fallback for limited terminals
const LOGO_ASCII = [
  "  DDDD   EEEEE  U   U  SSSS ",
  "  D   D  E      U   U  S    ",
  "  D   D  EEE    U   U   SS  ",
  "  D   D  E      U   U     S ",
  "  DDDD   EEEEE  UUUUU  SSSS ",
];

/** Render the logo rows for N letters (1-4) */
function renderLogoFrame(letterCount: number): string[] {
  const lines: string[] = [];
  for (let row = 0; row < 6; row++) {
    const shadow = row === 5 ? LOGO_FLOOR : LOGO_INNER;
    let line = "  ";
    for (let l = 0; l < letterCount; l++) {
      line += colorLogo(LETTERS[l][row], LOGO_BLOCK[l], shadow[l]);
    }
    lines.push(line);
  }
  return lines;
}

/** Print static banner (instant) */
export function banner(version?: string): void {
  console.log("");

  if (isUnicode && !noColor) {
    for (const line of renderLogoFrame(4)) {
      console.log(line);
    }
  } else {
    for (const line of LOGO_ASCII) {
      console.log(c.cyan(line));
    }
  }

  console.log("");
  const tag = c.dim("  Agentic Engineering");
  const ver = version ? `  ${c.dim("v" + version)}` : "";
  console.log(tag + ver);
  console.log("");
}

/**
 * Animated banner — letters reveal left-to-right.
 * Total animation: ~320ms (4 letters x 80ms).
 * Falls back to static banner in no-color or non-unicode terminals.
 */
export async function animatedBanner(version?: string): Promise<void> {
  if (!isUnicode || noColor) {
    banner(version);
    return;
  }

  const out = process.stdout;
  const LOGO_ROWS = 6;
  const FRAME_DELAY = 80;

  console.log(""); // blank line before logo

  // Print initial empty lines (placeholder for logo)
  for (let i = 0; i < LOGO_ROWS; i++) {
    out.write("\n");
  }

  // Animate: reveal one letter at a time
  for (let letterCount = 1; letterCount <= 4; letterCount++) {
    // Move cursor up to overwrite
    out.write(`${ESC}${LOGO_ROWS}A`);

    const frame = renderLogoFrame(letterCount);
    for (const line of frame) {
      out.write(`${ESC}2K${line}\n`); // clear line + print
    }

    if (letterCount < 4) {
      await sleep(FRAME_DELAY);
    }
  }

  // Tagline + version (with fade-in delay)
  await sleep(100);
  console.log("");
  const tag = c.dim("  Agentic Engineering");
  const ver = version ? `  ${c.dim("v" + version)}` : "";
  console.log(tag + ver);
  console.log("");
}

// ── Spinner ──────────────────────────────────────────────────────────

const SPINNER_FRAMES = isUnicode
  ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  : ["-", "\\", "|", "/"];

const SPINNER_INTERVAL = 80;

export interface Spinner {
  /** Update the spinner text while it's running */
  update(text: string): void;
  /** Stop with a success message */
  succeed(text?: string): void;
  /** Stop with a failure message */
  fail(text?: string): void;
  /** Stop with a warning message */
  warn(text?: string): void;
  /** Stop with an info message */
  info(text?: string): void;
  /** Stop and clear the line */
  stop(): void;
}

export function spinner(text: string): Spinner {
  let frameIdx = 0;
  let currentText = text;
  let stopped = false;

  const stream = process.stderr;

  function render() {
    if (stopped) return;
    const frame = c.cyan(SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length]);
    stream.write(`\r${ESC}2K  ${frame} ${currentText}`);
    frameIdx++;
  }

  const interval = setInterval(render, SPINNER_INTERVAL);
  render();

  function stop(symbol: string, finalText: string) {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    stream.write(`\r${ESC}2K  ${symbol} ${finalText}\n`);
  }

  return {
    update(t: string) {
      currentText = t;
    },
    succeed(t?: string) {
      stop(c.green(sym.tick), t ?? currentText);
    },
    fail(t?: string) {
      stop(c.red(sym.cross), t ?? currentText);
    },
    warn(t?: string) {
      stop(c.yellow(sym.warning), t ?? currentText);
    },
    info(t?: string) {
      stop(c.blue(sym.info), t ?? currentText);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      stream.write(`\r${ESC}2K`);
    },
  };
}

// ── Box ──────────────────────────────────────────────────────────────

/** Draw a rounded box around content lines */
export function box(
  lines: string[],
  opts?: { padding?: number; borderColor?: (s: string) => string; width?: number }
): void {
  const { padding = 1, borderColor = c.dim, width } = opts ?? {};
  const pad = " ".repeat(padding);

  // Calculate width from content (strip ANSI for measurement)
  const stripped = lines.map(stripAnsi);
  const contentWidth = width ?? Math.max(...stripped.map((l) => l.length));
  const innerWidth = contentWidth + padding * 2;

  const top = borderColor(`  ${sym.tl}${sym.h.repeat(innerWidth)}${sym.tr}`);
  const bot = borderColor(`  ${sym.bl}${sym.h.repeat(innerWidth)}${sym.br}`);
  const empty = borderColor(`  ${sym.v}`) + " ".repeat(innerWidth) + borderColor(sym.v);

  console.log(top);
  console.log(empty);
  for (let i = 0; i < lines.length; i++) {
    const visible = stripped[i].length;
    const rightPad = " ".repeat(Math.max(0, contentWidth - visible));
    console.log(borderColor(`  ${sym.v}`) + pad + lines[i] + rightPad + pad + borderColor(sym.v));
  }
  console.log(empty);
  console.log(bot);
}

// ── Section / Divider ────────────────────────────────────────────────

/** Print a labeled divider line */
export function divider(label?: string, width = 44): void {
  if (label) {
    const lineLen = Math.max(0, width - label.length - 3);
    console.log(c.dim(`  ${sym.h.repeat(2)} ${label} ${sym.h.repeat(lineLen)}`));
  } else {
    console.log(c.dim(`  ${sym.h.repeat(width)}`));
  }
}

// ── Key-Value Output ─────────────────────────────────────────────────

/** Print a labeled value with consistent alignment */
export function kv(label: string, value: string, labelWidth = 12): void {
  const paddedLabel = label.padEnd(labelWidth);
  console.log(`  ${c.dim(paddedLabel)} ${value}`);
}

// ── Messages ─────────────────────────────────────────────────────────

export function success(text: string): void {
  console.log(`  ${c.green(sym.tick)} ${text}`);
}

export function error(text: string): void {
  console.log(`  ${c.red(sym.cross)} ${text}`);
}

export function warn(text: string): void {
  console.log(`  ${c.yellow(sym.warning)} ${text}`);
}

export function info(text: string): void {
  console.log(`  ${c.blue(sym.info)} ${text}`);
}

export function hint(text: string): void {
  console.log(c.dim(`  ${text}`));
}

export function blank(): void {
  console.log("");
}

// ── Gradient Text ────────────────────────────────────────────────────

/** Apply a gradient across a text string (from → to RGB) */
export function gradientText(
  text: string,
  from: [number, number, number],
  to: [number, number, number]
): string {
  if (noColor) return text;
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const t = text.length > 1 ? i / (text.length - 1) : 0;
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    result += rgb(r, g, b, text[i]);
  }
  return result;
}

// ── Status Line ──────────────────────────────────────────────────────

/**
 * A persistent status line at the bottom of the terminal.
 * Updates in place without scrolling. Shows the server is alive.
 */
export function statusLine(getText: () => string, intervalMs = 1000): { stop: () => void } {
  const stream = process.stderr;
  let stopped = false;
  let dotCount = 0;
  const dots = ["   ", ".  ", ".. ", "..."];

  function render() {
    if (stopped) return;
    const dot = c.dim(dots[dotCount % dots.length]);
    stream.write(`\r${ESC}2K  ${c.dim(sym.dot)} ${getText()}${dot}`);
    dotCount++;
  }

  const interval = setInterval(render, intervalMs);
  render();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      stream.write(`\r${ESC}2K`);
    },
  };
}

// ── Progress Bar ─────────────────────────────────────────────────────

const BAR_WIDTH = 30;
const BAR_FILLED = isUnicode ? "█" : "#";
const BAR_EMPTY = isUnicode ? "░" : ".";

export function progressBar(current: number, total: number, label?: string): void {
  const pct = Math.min(1, current / total);
  const filled = Math.round(pct * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = c.cyan(BAR_FILLED.repeat(filled)) + c.dim(BAR_EMPTY.repeat(empty));
  const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
  const extra = label ? ` ${c.dim(label)}` : "";
  process.stderr.write(`\r${ESC}2K  ${bar} ${pctStr}${extra}`);
}

export function progressBarDone(text: string): void {
  process.stderr.write(`\r${ESC}2K`);
  success(text);
}

// ── Utilities ────────────────────────────────────────────────────────

/** Strip ANSI escape codes for length calculation */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Sleep for ms */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
