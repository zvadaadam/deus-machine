/**
 * Interactive terminal prompt primitives.
 *
 * Zero dependencies — uses raw ANSI escape codes and process.stdin in raw mode.
 * Provides select (arrow keys), text input (with masking), and confirm prompts.
 */

import { c, sym } from "./ui.js";

const ESC = "\x1b[";

// ── Select ───────────────────────────────────────────────────────────

export interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

/**
 * Arrow-key single-select from a list of options.
 * Returns the selected value.
 */
export async function select<T>(opts: { message: string; options: SelectOption<T>[] }): Promise<T> {
  const { message, options } = opts;
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error(
      "Interactive prompts require a TTY. Run in a terminal or set ANTHROPIC_API_KEY env var."
    );
  }
  const stream = process.stderr;

  let selected = 0;

  // Print message
  stream.write(`  ${message}\n`);

  function render() {
    // Move cursor up to overwrite options
    if (selected >= 0) {
      stream.write(`${ESC}${options.length}A`);
    }

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isActive = i === selected;
      const pointer = isActive ? c.cyan(sym.pointer) : " ";
      const label = isActive ? c.cyan(opt.label) : c.dim(opt.label);
      const hintText = opt.hint ? `  ${c.dim(opt.hint)}` : "";
      stream.write(`${ESC}2K  ${pointer} ${label}${hintText}\n`);
    }
  }

  // Initial render
  for (let i = 0; i < options.length; i++) stream.write("\n");
  render();

  return new Promise<T>((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    function cleanup() {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    function onData(buf: Buffer) {
      const key = buf.toString();

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        stream.write("\n");
        process.exit(130);
      }

      // Arrow up
      if (key === "\x1b[A" || key === "k") {
        selected = (selected - 1 + options.length) % options.length;
        render();
        return;
      }

      // Arrow down
      if (key === "\x1b[B" || key === "j") {
        selected = (selected + 1) % options.length;
        render();
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        cleanup();
        // Clear options and show selected
        stream.write(`${ESC}${options.length}A`);
        for (let i = 0; i < options.length; i++) {
          stream.write(`${ESC}2K\n`);
        }
        stream.write(`${ESC}${options.length}A`);
        stream.write(`${ESC}2K  ${c.green(sym.tick)} ${options[selected].label}\n`);
        resolve(options[selected].value);
      }
    }

    stdin.on("data", onData);
  });
}

// ── Input ────────────────────────────────────────────────────────────

/**
 * Free-text input with optional masking (for API keys).
 * Shows first 7 chars then masks the rest with bullets.
 */
export async function input(opts: {
  message: string;
  placeholder?: string;
  mask?: boolean;
}): Promise<string> {
  const { message, placeholder, mask } = opts;
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error(
      "Interactive prompts require a TTY. Run in a terminal or set ANTHROPIC_API_KEY env var."
    );
  }
  const stream = process.stderr;

  let value = "";

  function renderValue(): string {
    if (!value) {
      return placeholder ? c.dim(placeholder) : "";
    }
    if (mask) {
      // Show first 7 chars (e.g. "sk-ant-") then mask
      const visible = value.slice(0, 7);
      const hidden = "•".repeat(Math.max(0, value.length - 7));
      return visible + c.dim(hidden);
    }
    return value;
  }

  // Print prompt
  stream.write(`  ${message}\n`);
  stream.write(`${ESC}2K  ${renderValue()}`);

  return new Promise<string>((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    function cleanup() {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    function onData(buf: Buffer) {
      const key = buf.toString();

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        stream.write("\n");
        process.exit(130);
      }

      // Enter — submit
      if (key === "\r" || key === "\n") {
        cleanup();
        stream.write(`\r${ESC}2K  ${c.green(sym.tick)} ${mask ? renderValue() : value}\n`);
        resolve(value);
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\x08") {
        value = value.slice(0, -1);
        stream.write(`\r${ESC}2K  ${renderValue()}`);
        return;
      }

      // Ignore other control characters
      if (key.charCodeAt(0) < 32) return;

      // Paste support — handle multiple chars at once
      value += key;
      stream.write(`\r${ESC}2K  ${renderValue()}`);
    }

    stdin.on("data", onData);
  });
}

// ── Confirm ──────────────────────────────────────────────────────────

/**
 * Yes/No confirmation prompt.
 */
export async function confirm(opts: { message: string; default?: boolean }): Promise<boolean> {
  const { message, default: defaultValue = true } = opts;
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error(
      "Interactive prompts require a TTY. Run in a terminal or set ANTHROPIC_API_KEY env var."
    );
  }
  const stream = process.stderr;

  const hint = defaultValue ? `[${c.bold("Y")}/n]` : `[y/${c.bold("N")}]`;
  stream.write(`  ${message} ${hint} `);

  return new Promise<boolean>((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    function cleanup() {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    function onData(buf: Buffer) {
      const key = buf.toString().toLowerCase();

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        stream.write("\n");
        process.exit(130);
      }

      if (key === "y") {
        cleanup();
        stream.write(`\r${ESC}2K  ${c.green(sym.tick)} ${message} ${c.dim("Yes")}\n`);
        resolve(true);
        return;
      }

      if (key === "n") {
        cleanup();
        stream.write(`\r${ESC}2K  ${c.dim(sym.dash)} ${message} ${c.dim("No")}\n`);
        resolve(false);
        return;
      }

      // Enter = default
      if (key === "\r" || key === "\n") {
        cleanup();
        const result = defaultValue;
        const icon = result ? c.green(sym.tick) : c.dim(sym.dash);
        const text = result ? c.dim("Yes") : c.dim("No");
        stream.write(`\r${ESC}2K  ${icon} ${message} ${text}\n`);
        resolve(result);
        return;
      }
    }

    stdin.on("data", onData);
  });
}
