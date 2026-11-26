import { z } from "zod";
import { live, out, write } from "./op";
import { GATEWAY_FORMATS, GATEWAY_KINDS, type GatewayStatus } from "../gateways";

export const gateways = live({ name: "gateways", output: out<GatewayStatus[]>() });
export const connectGateway = write({
  name: "connectGateway",
  input: z.object({
    address: z.string().trim().max(256),
    clientKey: z.string().trim().min(1).max(4096).optional(),
    generation: z.string().uuid().nullable(),
    preset: z.enum(GATEWAY_KINDS),
    formats: z.array(z.enum(GATEWAY_FORMATS)).max(2).optional(),
  }),
  output: out<void>(),
});
const connection = z.object({ generation: z.string().uuid() });

export const disconnectGateway = write({
  name: "disconnectGateway",
  input: connection,
  output: out<void>(),
});

export const refreshGateway = write({
  name: "refreshGateway",
  input: connection,
  output: out<void>(),
});
