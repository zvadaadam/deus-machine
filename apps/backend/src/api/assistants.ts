/** Answers the operations in `shared/api/assistants.ts`. */

import * as api from "@shared/api/assistants";
import { NotFoundError } from "../lib/errors";
import { listAssistants, removeAssistant, setAssistantAccess } from "../services/assistants";
import { answerMcp } from "../services/assistants/operator";
import { handle } from "./registry";

export default [
  // The operator tools over MCP: the only operation an assistant may ask for
  // (ASSISTANT_OPERATIONS). Each tool call is checked against its access.
  handle(api.agentMcp, ({ message }, { caller }) => answerMcp(message, caller)),

  // Managing assistants: never reached by one.
  handle(api.assistants, () => listAssistants()),
  handle(api.setAssistantAccess, ({ clientId, access }) => {
    if (!setAssistantAccess(clientId, access)) throw new NotFoundError("Assistant not found");
  }),
  handle(api.removeAssistant, ({ clientId }) => {
    if (!removeAssistant(clientId)) throw new NotFoundError("Assistant not found");
  }),
];
