import { DEFAULT_MODEL, resolveModelSelection } from "@/shared/agents";

const LAST_MODEL_KEY = "deus:welcome-last-model";

export function getStoredModel(): string {
  // Validate against the catalog — stale localStorage (old aliases like
  // "claude:sonnet", removed models, renamed formats) falls back to the
  // current default instead of silently sending an unknown model.
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
