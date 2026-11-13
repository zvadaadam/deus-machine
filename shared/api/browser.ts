/** Browser: the dev servers found on the computer that runs the backend. */

import type { LocalServersSnapshot } from "../types/local-server";
import { live, out } from "./op";

/** The dev servers answering on this computer's common ports, for the Browser tab's empty state. */
export const localServers = live({ name: "local_servers", output: out<LocalServersSnapshot>() });
