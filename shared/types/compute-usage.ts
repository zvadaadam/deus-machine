/** Recorded execution time; active machines are counted separately. */
export interface CloudComputeUsage {
  concurrencyLimit: number;
  activeReservations: number;
  runtimeMs: number;
  runtimeMinutes: number;
  providerRuntimeMs: number;
  estimatedRuntimeMs: number;
  unsettledExecutionCount: number;
  from: string;
  to: string;
}
