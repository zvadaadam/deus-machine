import { fileURLToPath } from "node:url";
import { BACKEND_CHILD_ENV_DENYLIST } from "../../shared/lib/child-env";

// A shell from an older installed Deus still carries that backend's database
// and runtime settings. Only checkout entry points load this module.
if (process.env.DEUS_PACKAGED === "1") {
  for (const key of BACKEND_CHILD_ENV_DENYLIST) delete process.env[key];
}
process.env.DEUS_DEV_ROOT = fileURLToPath(new URL("../../", import.meta.url));
