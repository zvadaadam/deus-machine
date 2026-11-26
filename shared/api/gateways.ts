import { z } from "zod";
import { live, out, write } from "./op";
import { GATEWAY_FORMATS, GATEWAY_PRESET_IDS, type GatewayStatus } from "../gateways";

export const gateways = live({ name: "gateways", output: out<GatewayStatus[]>() });
export const connectGateway = write({
  name: "connectGateway",
  input: z.object({
    baseUrl: z.string().trim().max(256),
    apiKey: z.string().trim().min(1).max(4096).optional(),
    revision: z.string().uuid().nullable(),
    preset: z.enum(GATEWAY_PRESET_IDS),
    formats: z.array(z.enum(GATEWAY_FORMATS)).max(2).optional(),
  }),
  output: out<void>(),
});
const connection = z.object({ revision: z.string().uuid() });

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
