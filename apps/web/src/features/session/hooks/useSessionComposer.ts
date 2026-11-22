import { useStore } from "zustand";
import { useEffect, useMemo } from "react";
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from "@/shared/agents";
import {
  composerStore,
  composerTarget,
  emptyComposer,
  sessionComposerActions as actions,
} from "../store/sessionComposerStore";

interface ComposerOptions {
  initialModel?: string;
  initialThinking?: ThinkingLevel;
  defaultThinking: ThinkingLevel;
}

export function useSessionComposer(
  id: string,
  { initialModel, initialThinking, defaultThinking }: ComposerOptions = {
    defaultThinking: DEFAULT_THINKING_LEVEL,
  }
) {
  const store = composerStore();
  const target = useMemo(() => composerTarget(id, store), [id, store]);
  const seedThinking = initialThinking ?? defaultThinking;
  const initial = useMemo(
    () => emptyComposer(initialModel, seedThinking),
    [initialModel, seedThinking]
  );
  useEffect(() => actions.seedIfAbsent(target, initial), [target, initial]);
  const state = useStore(store, (s) => s.composers[id] ?? initial);

  const setters = useMemo(
    () => ({
      setDraft: (v: string) => actions.setDraft(target, v),
      setModel: (v: string, levels: readonly ThinkingLevel[] | undefined) =>
        actions.setModel(target, v, levels, defaultThinking),
      setThinkingLevel: (level: ThinkingLevel) => actions.setThinkingLevel(target, level),
      togglePlanMode: () => actions.togglePlanMode(target),
      addPastedText: (text: string) => actions.addPastedText(target, text),
      removePastedText: (id: string) => actions.removePastedText(target, id),
      addFileMention: (v: Parameters<typeof actions.addFileMention>[1]) =>
        actions.addFileMention(target, v),
      removeFileMention: (id: string) => actions.removeFileMention(target, id),
      addSkillMention: (v: Parameters<typeof actions.addSkillMention>[1]) =>
        actions.addSkillMention(target, v),
      removeSkillMention: (id: string) => actions.removeSkillMention(target, id),
      removeInspectedElement: (id: string) => actions.removeInspectedElement(target, id),
      removeImageAttachment: (id: string) => actions.removeImageAttachment(target, id),
      dismissMissingAttachments: () => actions.dismissMissingAttachments(target),
    }),
    [target, defaultThinking]
  );

  return { ...state, ...setters, clearSent: () => actions.clearSent(target, state) };
}
