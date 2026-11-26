import * as api from "@shared/api/gateways";
import { AppError } from "../lib/errors";
import * as gateways from "../services/gateways/connections";
import { handle, type Ctx } from "./registry";

function fromThisComputer<Input, Result>(run: (input: Input) => Result) {
  return (input: Input, { caller }: Ctx) => {
    if (caller.relayed || caller.deviceId !== null || caller.assistant !== null)
      throw new AppError(403, "Manage gateways on this computer.");
    return run(input);
  };
}

export default [
  handle(api.gateways, gateways.gatewayStatuses),
  handle(api.connectGateway, fromThisComputer(gateways.connectGateway)),
  handle(
    api.disconnectGateway,
    fromThisComputer(({ revision }) => gateways.disconnectGateway(revision))
  ),
  handle(
    api.refreshGateway,
    fromThisComputer(({ revision }) => gateways.refreshGateway(revision))
  ),
];
