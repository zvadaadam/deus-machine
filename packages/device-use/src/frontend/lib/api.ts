// Typed fetch wrappers around the server's HTTP API.

export interface PersistedState {
  version: 1;
  simulator?: { udid: string };
  project?: { path: string; scheme?: string; configuration?: string };
  updatedAt: number;
}

export interface Simulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export interface StreamInfo {
  udid: string;
  port: number;
  url: string;
}

export interface InvokeResult<T = unknown> {
  tool: string;
  id: string;
  success: boolean;
  result?: T;
  error?: string;
}

async function postTool<T = unknown>(name: string, params: unknown = {}): Promise<InvokeResult<T>> {
  const res = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

export const api = {
  getState: async (): Promise<PersistedState> => (await fetch("/api/state")).json(),
  getStream: async (): Promise<StreamInfo | null> => (await fetch("/api/stream")).json(),
  listDevices: () => postTool<{ devices: Simulator[] }>("list_devices"),
  boot: (udid: string) => postTool("boot", { udid }),
  setActiveSimulator: (udid: string) => postTool("set_active_simulator", { udid }),
  setActiveProject: (path: string, scheme?: string, configuration?: string) =>
    postTool("set_active_project", { path, scheme, configuration }),
  getProjectInfo: (path: string) =>
    postTool<{ name: string; schemes: string[]; targets: string[]; configurations: string[] }>(
      "get_project_info",
      { path }
    ),
  build: (params?: { project?: string; scheme?: string; udid?: string; configuration?: string }) =>
    postTool("build", params ?? {}),
  install: (appPath: string, udid?: string) => postTool("install", { appPath, udid }),
  launchApp: (bundleId: string, udid?: string) => postTool("launch_app", { bundleId, udid }),
  snapshot: () =>
    postTool<{
      counts: { total: number; interactive: number };
      refs: Array<{ ref: string; label?: string; type?: string; identifier?: string }>;
      tree?: unknown;
      rendered?: string;
    }>("snapshot", { format: "json", interactiveOnly: false }),
  tap: (params: { ref?: string; x?: number; y?: number; label?: string; udid?: string }) =>
    postTool("tap", params),
};
