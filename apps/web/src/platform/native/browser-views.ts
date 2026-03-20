import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

// All browser view operations. No-op in web mode since BrowserView is Electron-only.
// These are ONLY called from browser feature components that are already gated
// by capabilities.nativeBrowser, but the internal check is defense-in-depth.

export async function create(params: {
  label: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  windowLabel?: string;
}): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("create_browser_webview", params);
}

export async function navigate(label: string, url: string): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("navigate_browser_webview", { label, url });
}

export async function evaluate(label: string, js: string): Promise<unknown> {
  if (!capabilities.nativeBrowser) return null;
  return invoke("eval_browser_webview", { label, js });
}

export async function evaluateWithResult(
  label: string,
  js: string,
  timeoutMs?: number
): Promise<string | null> {
  if (!capabilities.nativeBrowser) return null;
  return invoke<string | null>("eval_browser_webview_with_result", {
    label,
    js,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  });
}

export async function show(label: string): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("show_browser_webview", { label });
}

export async function hide(label: string): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("hide_browser_webview", { label });
}

export async function close(label: string): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("close_browser_webview", { label });
}

export async function setBounds(
  label: string,
  bounds: { x: number; y: number; width: number; height: number }
): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("set_browser_webview_bounds", { label, ...bounds });
}

export async function screenshot(
  label: string,
  opts?: Record<string, unknown>
): Promise<string | null> {
  if (!capabilities.nativeBrowser) return null;
  return invoke<string | null>("screenshot_browser_webview", { label, ...opts });
}

export async function reload(label: string): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("reload_browser_webview", { label });
}

export async function openDevtools(label: string): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("open_browser_devtools", { label });
}

export async function closeDevtools(label: string): Promise<void> {
  if (!capabilities.nativeBrowser) return;
  await invoke("close_browser_devtools", { label });
}

export async function getUrl(label: string): Promise<string> {
  if (!capabilities.nativeBrowser) return "";
  try {
    return (await invoke<string>("get_browser_webview_url", { label })) ?? "";
  } catch {
    return "";
  }
}

export async function getCookieBrowsers(): Promise<unknown[]> {
  if (!capabilities.nativeBrowser) return [];
  try {
    return (await invoke<unknown[]>("get_cookie_browsers")) ?? [];
  } catch {
    return [];
  }
}

export async function syncCookies(browserName: string, domain: string): Promise<unknown[]> {
  if (!capabilities.nativeBrowser) return [];
  try {
    return (await invoke<unknown[]>("sync_browser_cookies", { browserName, domain })) ?? [];
  } catch {
    return [];
  }
}

export async function injectCookies(label: string, cookies: unknown[]): Promise<number> {
  if (!capabilities.nativeBrowser) return 0;
  try {
    return (await invoke<number>("inject_browser_cookies", { label, cookies })) ?? 0;
  } catch {
    return 0;
  }
}

export async function createDetachedWindow(params: {
  url: string;
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}): Promise<void> {
  if (!capabilities.secondaryWindows) return;
  await invoke("browser:createDetachedWindow", params);
}

export async function closeDetachedWindow(): Promise<void> {
  if (!capabilities.secondaryWindows) return;
  await invoke("browser:closeDetachedWindow");
}
