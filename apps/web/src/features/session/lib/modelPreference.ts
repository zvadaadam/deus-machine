import { resolveModelSelection } from "@/shared/agents";

const LAST_MODEL_KEY = "deus:welcome-last-model";

export function getStoredModel(): string | undefined {
  try {
    const stored = localStorage.getItem(LAST_MODEL_KEY);
    return stored ? resolveModelSelection(stored) : undefined;
  } catch {
    return undefined;
  }
}

export function setStoredModel(model: string) {
  try {
    localStorage.setItem(LAST_MODEL_KEY, model);
  } catch {
    /* localStorage unavailable */
  }
}
