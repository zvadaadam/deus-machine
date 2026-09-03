/**
 * The platform's simulator error texts, in product words. Two of them have a
 * known remedy the user can act on; everything else is shown verbatim.
 */
export function describeCloudSimulatorError(error: string | null): string {
  if (!error) return "The device failed to start.";
  // Backend-synthesized: the sandbox's sidecar is from before simulator
  // control existed. Only a restart of the computer upgrades it.
  if (/predates simulator control/i.test(error)) {
    return "This computer needs an upgrade before it can run a device — restart the workspace to get it.";
  }
  // The environment was created without `simulator`; every environment deus
  // builds now includes it, so only older workspaces hit this.
  if (/not enabled for this workspace/i.test(error)) {
    return "This workspace's environment has no simulator; new cloud workspaces get one.";
  }
  return error;
}
