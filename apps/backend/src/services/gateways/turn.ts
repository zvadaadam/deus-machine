import type { CredentialSource } from "@zvada/agent-server/core";
import { tokenDigest } from "@zvada/agent-server/protocol";
import { isUnknownEvent, type DecodedWireEventEnvelope } from "@shared/protocol-types";
import type { ThinkingLevel } from "@shared/protocol";
import { gatewayLabel, gatewayEffort, gatewaySupports, gatewayThinking } from "@shared/gateways";
import { getSessionRaw } from "../../db";
import { getDatabase } from "../../lib/database";
import { GatewayError } from "../../lib/errors";
import { connectionFor, requireRevision } from "./connections";
import {
  holdingTurn,
  gatewayExecution,
  type GatewayAttribution,
  type GatewayTurn,
} from "../agent/chat-turn";

export async function prepareGatewayTurn(
  turn: GatewayTurn,
  level?: ThinkingLevel,
  signal?: AbortSignal
) {
  const { binding, execution } = turn;
  const connection = await connectionFor(binding.revision);
  const name = gatewayLabel(connection, [connection]);
  const model = connection.models.find((row) => row.id === execution.model);
  if (!model || !gatewaySupports(connection, model, execution.harness))
    throw new GatewayError(
      name +
        " has no chat route for this model with the selected agent. Choose another model in the picker.",
      "no_route"
    );
  signal?.throwIfAborted();
  execution.via = name;
  execution.modelLabel = model.label;
  turn.thinkingLevel = gatewayEffort(gatewayThinking(model, execution.harness), level);
  const endpointUrl = connection.baseUrl + (binding.format === "responses" ? "/v1" : "");
  turn.delivery = { apiKey: connection.apiKey, baseUrl: endpointUrl };
}

export const gatewayCredential: CredentialSource = async (request, signal) => {
  if (request.purpose === "models") return;
  const { harness, sessionId } = request;
  const holder = holdingTurn(sessionId);
  const gateway = holder?.gateway;
  if (!gateway) {
    if (request.rejectedSha256 || getSessionRaw(getDatabase(), sessionId)?.gateway_revision)
      throw new GatewayError("The gateway turn is no longer active.");
    return;
  }
  if (
    holder.turnId !== request.turnId ||
    holder.phase === "preparing" ||
    gateway.execution.harness !== harness ||
    !gateway.delivery
  )
    throw new GatewayError("The gateway turn is no longer active.");
  if (request.rejectedSha256) {
    if (
      (await tokenDigest(gateway.delivery.apiKey)) !== request.rejectedSha256 ||
      holdingTurn(sessionId) !== holder
    )
      throw new GatewayError("The gateway credential does not belong to this turn.");
  }
  requireRevision(gateway.binding.revision);
  signal?.throwIfAborted();
  return { type: "api_key", ...gateway.delivery, binding: gateway.binding };
};

export function gatewayTurnEvent(
  envelope: DecodedWireEventEnvelope,
  gateway?: GatewayAttribution
): DecodedWireEventEnvelope {
  const { event } = envelope;
  if (!gateway || isUnknownEvent(event)) return envelope;
  if (event.type === "error") return { ...envelope, event: withGatewayDeadline(event) };
  if (event.type !== "turn.started" && event.type !== "turn.ended") return envelope;
  const execution = { ...event.execution, ...gatewayExecution(gateway) };
  return {
    ...envelope,
    event: {
      ...event,
      execution,
      ...(event.type === "turn.ended" &&
        event.error && { error: withGatewayDeadline(event.error) }),
    },
  };
}

function withGatewayDeadline<T extends { retryAt?: number; retryAtSource?: string }>(error: T): T {
  const at = error.retryAt;
  if (at === undefined || (Number.isSafeInteger(at) && at >= 0 && at <= Date.now() + 7 * 86400000))
    return error;
  const clean = { ...error };
  delete clean.retryAt;
  delete clean.retryAtSource;
  return clean;
}
