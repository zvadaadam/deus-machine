import { invoke } from "@/platform/tauri";
import type { InstalledApp, SimulatorInfo, StreamInfo } from "../types";

export const simulatorService = {
  /** Fast probe: does this workspace contain a buildable Xcode project? */
  hasXcodeProject: (workspacePath: string) =>
    invoke<boolean>("sim_has_xcode_project", { workspacePath }),

  listSimulators: () => invoke<SimulatorInfo[]>("list_simulators"),

  /** Check if a streaming session is alive for this workspace. */
  getStreamInfo: (workspaceId: string) =>
    invoke<StreamInfo | null>("get_stream_info", { workspaceId }),

  startStreaming: (workspaceId: string, udid: string) =>
    invoke<StreamInfo>("start_streaming", { workspaceId, udid }),

  stopStreaming: (workspaceId: string) =>
    invoke<void>("stop_streaming", { workspaceId }),

  sendTouch: (workspaceId: string, x: number, y: number, touchType: string) =>
    invoke<void>("sim_send_touch", { workspaceId, x, y, touchType }),

  sendScroll: (workspaceId: string, x: number, y: number, dx: number, dy: number) =>
    invoke<void>("sim_send_scroll", { workspaceId, x, y, dx, dy }),

  sendKey: (workspaceId: string, keycode: number, direction: string) =>
    invoke<void>("sim_send_key", { workspaceId, keycode, direction }),

  sendButton: (workspaceId: string, buttonType: string, direction: string) =>
    invoke<void>("sim_send_button", { workspaceId, buttonType, direction }),

  takeScreenshot: (workspaceId: string) =>
    invoke<number[]>("sim_take_screenshot", { workspaceId }),

  pressHome: (workspaceId: string) =>
    invoke<void>("sim_press_home", { workspaceId }),

  installApp: (workspaceId: string, appPath: string) =>
    invoke<InstalledApp>("sim_install_app", { workspaceId, appPath }),

  launchApp: (workspaceId: string, bundleId: string) =>
    invoke<void>("sim_launch_app", { workspaceId, bundleId }),

  terminateApp: (workspaceId: string, bundleId: string) =>
    invoke<void>("sim_terminate_app", { workspaceId, bundleId }),

  uninstallApp: (workspaceId: string, bundleId: string) =>
    invoke<void>("sim_uninstall_app", { workspaceId, bundleId }),

  buildAndRun: (workspaceId: string, workspacePath: string) =>
    invoke<InstalledApp>("sim_build_and_run", { workspaceId, workspacePath }),
};
