import { useCallback, useState } from "react";
import { getStoredModel, setStoredModel } from "@/features/session/lib/modelPreference";
import { useDefaultThinkingLevel } from "@/features/settings/api";
import {
  fitThinkingLevel,
  getAgentHarnessForModel,
  getModelId,
  modelThinkingLevels,
  type ThinkingLevel,
} from "@/shared/agents";
import { useModelLists } from "@/shared/hooks/useModelLists";

/**
 * What a chat started from a prompt-first composer runs on. The model is the
 * one last picked there; the thinking level is the user's default until they
 * pick another for this chat, and always one the model offers. A cloud
 * workspace chooses from the platform's models.
 */
export function useNewChatSelection(location: "local" | "cloud") {
  const [model, setModelState] = useState(getStoredModel);
  const [pickedLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const defaultThinking = useDefaultThinkingLevel();
  const lists = useModelLists({ cloud: location === "cloud" });
  const thinkingLevels = modelThinkingLevels(
    lists,
    getAgentHarnessForModel(model),
    getModelId(model)
  );
  const setModel = useCallback((value: string) => {
    setModelState(value);
    setStoredModel(value);
  }, []);
  return {
    model,
    lists,
    thinkingLevels,
    thinkingLevel: fitThinkingLevel(
      pickedLevel ?? defaultThinking,
      thinkingLevels,
      defaultThinking
    ),
    /** The level the first turn names; none for a model with no thinking control. */
    sentThinkingLevel: thinkingLevels.length
      ? fitThinkingLevel(pickedLevel ?? defaultThinking, thinkingLevels, defaultThinking)
      : undefined,
    setModel,
    setThinkingLevel,
  };
}
