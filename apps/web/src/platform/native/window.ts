import { capabilities } from "../capabilities";
import { invoke } from "../electron/invoke";

export async function show(): Promise<void> {
  if (!capabilities.windowLifecycle) return;
  await invoke("show_main_window");
}

export async function setTitle(title: string): Promise<void> {
  if (!capabilities.windowLifecycle) return;
  await invoke("native:setTitle", { title });
}

export async function setZoom(level: number): Promise<void> {
  if (!capabilities.nativeWindowChrome) return;
  await invoke("native:setZoom", { level });
}

export async function enterOnboarding(): Promise<void> {
  if (!capabilities.nativeOnboarding) return;
  await invoke("enter_onboarding_mode");
}

export async function exitOnboarding(): Promise<void> {
  if (!capabilities.nativeOnboarding) return;
  await invoke("exit_onboarding_mode");
}
