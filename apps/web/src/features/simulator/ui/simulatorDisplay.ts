export function formatSimulatorRuntime(runtime: string | undefined): string {
  return runtime?.replace("com.apple.CoreSimulator.SimRuntime.", "") ?? "iOS Simulator";
}
