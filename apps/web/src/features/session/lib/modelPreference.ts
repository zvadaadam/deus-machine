import { DEFAULT_MODEL, resolveModelSelection } from "@/shared/agents";

const LAST_MODEL_KEY = "deus:welcome-last-model";

export function getStoredModel(): string {
  // A stored value from an older build may spell its harness the retired way
  // ("claude:sonnet") or name none; one that names no harness falls back to
  // the default.
  try {
    const stored = localStorage.getItem(LAST_MODEL_KEY);
    const resolved = stored ? resolveModelSelection(stored) : undefined;
    if (resolved) return resolved;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_MODEL;
}

export function setStoredModel(model: string) {
  try {
    localStorage.setItem(LAST_MODEL_KEY, model);
  } catch {
    /* localStorage unavailable */
  }
}
