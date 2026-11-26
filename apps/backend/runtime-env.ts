import { clearInheritedPackagedEnv, mergeProxyExclusions } from "../../shared/lib/child-env";

// The runtime configures this process before loading the server. A direct
// source import instead discards the settings it inherited from an older Deus.
let configured = false;
export function configureBackendEnv(configure = clearInheritedPackagedEnv): void {
  if (configured) return;
  configure(process.env);
  // Bun's fetch and the engine relay share this process, including its outbound proxy.
  mergeProxyExclusions(process.env, "localhost,127.0.0.1,::1,[::1]");
  configured = true;
}
