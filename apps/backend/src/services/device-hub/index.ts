import { dirname, join } from "node:path";
import { deviceHubStatus } from "@shared/api/device-hub";
import { DB_PATH } from "../../lib/database";
import { publish } from "../streams";
import { DeviceHub } from "./manager";

export const deviceHub = new DeviceHub({
  directory: join(dirname(DB_PATH), "device-hub"),
  changed: (status, scope) => publish(deviceHubStatus, scope, status),
});
