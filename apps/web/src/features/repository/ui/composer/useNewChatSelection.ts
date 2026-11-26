import { useCallback, useState } from "react";
import { getStoredModel, setStoredModel } from "@/features/session/lib/modelPreference";
import { useDefaultThinkingLevel } from "@/features/settings/api";
import { fitThinkingLevel, type ThinkingLevel } from "@/shared/agents";
import type { PickerOption } from "@/shared/agents/picker";
import { gatewayEffort } from "@shared/gateways";
import { useChatModel } from "@/shared/hooks/useModelLists";

/**
 * What a chat started from the Home composer runs on. The model is the
 * one last picked there; the thinking level is the user's default until they
 * pick another for this chat, and always one the model offers. A cloud
 * workspace chooses from the platform's models.
 */
export function useNewChatSelection(location: "local" | "cloud") {
  const [picked, setModelState] = useState(getStoredModel);
  const [pickedLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const defaultThinking = useDefaultThinkingLevel();
  const selection = useChatModel({ cloud: location === "cloud", picked });
  const thinkingLevel = selection.gatewayModel
    ? (gatewayEffort(selection.gatewayThinking, pickedLevel ?? undefined) ?? "off")
    : fitThinkingLevel(pickedLevel ?? defaultThinking, selection.thinkingLevels, defaultThinking);
  const setModel = useCallback(({ value }: PickerOption, level?: ThinkingLevel) => {
    if (level !== undefined) setThinkingLevel(level);
    setModelState(value);
    setStoredModel(value);
  }, []);
  return {
    ...selection,
    thinkingLevel,
    preferredThinking: pickedLevel,
    defaultThinking,
    /** The level the first turn names; none for a model with no thinking control. */
    sentThinkingLevel: selection.thinkingLevels.length ? thinkingLevel : undefined,
    setModel,
    setThinkingLevel,
  };
}
