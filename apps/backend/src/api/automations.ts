/** Answers the operations in `shared/api/automations.ts`. */

import * as api from "@shared/api/automations";
import {
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  openAutomationRun,
  refreshAutomations,
  runAutomationNow,
  toggleAutomation,
  updateAutomation,
} from "../services/automations";
import { handle } from "./registry";

// The service invalidates `automations` and `automationRuns` itself, and
// every write waits for Deus Cloud: a refusal there fails the write.
export default [
  handle(api.automations, () => listAutomations()),
  handle(api.automationRuns, ({ automationId }) => listAutomationRuns(automationId)),

  handle(api.saveAutomation, (input) => {
    if (!("automationId" in input)) return createAutomation(input, "user");
    const { automationId, ...changes } = input;
    return updateAutomation(automationId, changes);
  }),
  handle(api.deleteAutomation, ({ automationId }) => deleteAutomation(automationId)),
  handle(api.toggleAutomation, ({ automationId, status }) =>
    toggleAutomation(automationId, status)
  ),
  handle(api.runAutomationNow, async ({ automationId }) => ({
    runId: await runAutomationNow(automationId),
  })),
  handle(api.refreshAutomations, ({ automationId }) => refreshAutomations(automationId)),
  handle(api.openAutomationRun, ({ runId }) => openAutomationRun(runId)),
];
