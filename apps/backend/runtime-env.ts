import { clearInheritedPackagedEnv } from "../../shared/lib/child-env";

// The runtime configures this process before loading the server. A direct
// source import instead discards the settings it inherited from an older Deus.
let configured = false;
export function configureBackendEnv(configure = clearInheritedPackagedEnv): void {
  if (configured) return;
  configure(process.env);
  configured = true;
}
