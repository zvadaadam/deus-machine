// backend/src/services/automations/index.ts
// Automations — cloud-only: prompts the agnt platform runs on a schedule, in
// cloud sandboxes, with the Mac open or closed. The platform is the source of
// truth; deus mirrors it into a local cache. See docs/automations-plan.md.

export {
  createAutomation,
  updateAutomation,
  toggleAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  listAutomationRuns,
  runAutomationNow,
  refreshAutomations,
  openAutomationRun,
  initAutomations,
  automationsConfigured,
  validateSchedule,
  MIN_FIRE_INTERVAL_MS,
  type AutomationInput,
} from "./service";
export { handleAutomationToolRequest } from "./agent-rpc";
