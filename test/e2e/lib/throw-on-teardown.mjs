import {
  addConnection,
  onDeviceConnectionsChange,
} from "../../../apps/backend/src/services/ws.service.ts";

// Closing a paired connection notifies the device listener after the engine drains.
process.once("SIGTERM", () => {
  onDeviceConnectionsChange(null);
  addConnection({ send() {}, close() {} }, "fixture-device");
  onDeviceConnectionsChange(() => {
    throw new Error("fixture device disconnect failed");
  });
});
