/** Answers the operations in `shared/api/terminal.ts`. */

import * as api from "@shared/api/terminal";
import { ptyRouter } from "../services/node/pty";
import { handle } from "./registry";

export default [
  handle(api.ptySpawn, async (input) => ({ id: await ptyRouter.open(input) })),
  handle(api.ptyWrite, ({ id, data }) => ptyRouter.write(id, data)),
  handle(api.ptyResize, ({ id, cols, rows }) => ptyRouter.resize(id, cols, rows)),
  handle(api.ptyKill, ({ id }) => ptyRouter.kill(id)),
];
