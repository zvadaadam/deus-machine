import { invoke } from "@/platform/tauri";
import type { InstalledApp, SimulatorInfo, StreamInfo } from "../types";

export const simulatorService = {
  listSimulators: () => invoke<SimulatorInfo[]>("list_simulators"),

  startStreaming: (udid: string) =>
    invoke<StreamInfo>("start_streaming", { udid }),

  stopStreaming: () => invoke<void>("stop_streaming"),

  sendTouch: (x: number, y: number, touchType: string) =>
    invoke<void>("sim_send_touch", { x, y, touchType }),

  sendScroll: (x: number, y: number, dx: number, dy: number) =>
    invoke<void>("sim_send_scroll", { x, y, dx, dy }),

  sendKey: (keycode: number, direction: string) =>
    invoke<void>("sim_send_key", { keycode, direction }),

  sendButton: (buttonType: string, direction: string) =>
    invoke<void>("sim_send_button", { buttonType, direction }),

  takeScreenshot: () => invoke<number[]>("sim_take_screenshot"),

  pressHome: () => invoke<void>("sim_press_home"),

  installApp: (appPath: string) =>
    invoke<InstalledApp>("sim_install_app", { appPath }),

  launchApp: (bundleId: string) =>
    invoke<void>("sim_launch_app", { bundleId }),

  terminateApp: (bundleId: string) =>
    invoke<void>("sim_terminate_app", { bundleId }),

  uninstallApp: (bundleId: string) =>
    invoke<void>("sim_uninstall_app", { bundleId }),

  buildAndRun: (workspacePath: string) =>
    invoke<InstalledApp>("sim_build_and_run", { workspacePath }),
};
