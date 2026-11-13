/** Terminals: opening one in a workspace and driving it. */

import { z } from "zod";
import { out, write } from "./op";
import { stream } from "./stream";

/** The id the client chose when it opened the terminal. */
const terminal = z.object({ id: z.string().min(1) });
const size = { cols: z.number().int().positive(), rows: z.number().int().positive() };

/**
 * Open a terminal under an id the client chooses. Its output arrives as
 * `terminalOutput` data events, and its end as an exit event, under that id.
 */
export const ptySpawn = write({
  name: "ptySpawn",
  input: terminal.extend({
    command: z.string().default("bash"),
    args: z.array(z.string()).default([]),
    cols: size.cols.default(80),
    rows: size.rows.default(24),
    cwd: z.string().optional(),
    /** Run the shell in this cloud workspace's sandbox, which picks its own command. */
    cloudWorkspaceId: z.string().optional(),
  }),
  output: out<{ id: string }>(),
});

/** Type into a terminal. */
export const ptyWrite = write({
  name: "ptyWrite",
  input: terminal.extend({
    /** The input's bytes, one number each. */
    data: z.array(z.number()),
  }),
  output: out<void>(),
});

export const ptyResize = write({
  name: "ptyResize",
  input: terminal.extend(size),
  output: out<void>(),
});

/** Close a terminal. One that already ended is not an error. */
export const ptyKill = write({ name: "ptyKill", input: terminal, output: out<void>() });

/** What a terminal prints, and its end. */
export const terminalOutput = stream({
  name: "terminalOutput",
  scope: z.object({ id: z.string() }),
  event: out<{ type: "data"; data: number[] } | { type: "exit"; error?: string }>(),
});
