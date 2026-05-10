// backend/src/services/goals/goal-events.ts

import type { ActiveGoal, EndedGoal } from "@shared/goals";
import type { QServerFrame } from "@shared/types/query-protocol";
import { broadcast } from "../ws.service";

export function pushGoalUpdated(goal: ActiveGoal): void {
  pushEvent("goal:updated", goal);
}

export function pushGoalEnded(goal: EndedGoal): void {
  pushEvent("goal:ended", goal);
}

function pushEvent(event: "goal:updated" | "goal:ended", data: ActiveGoal | EndedGoal): void {
  const frame: QServerFrame = { type: "q:event", event, data };
  broadcast(JSON.stringify(frame));
}
