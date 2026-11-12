/** Every handler, collected. `registry` is what the query engine dispatches through. */

import { Registry } from "./registry";
import workspaces from "./workspaces";

export const registry = new Registry([...workspaces]);
