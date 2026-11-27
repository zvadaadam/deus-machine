import { useStore } from "zustand";
import { useEffect, useMemo } from "react";
import type { ThinkingLevel } from "@/shared/agents";
import {
  composerStore,
  composerTarget,
  type ComposerTarget,
  emptyComposer,
  HOME_COMPOSER_ID,
  sessionComposerActions as actions,
  stagedContent,
} from "../store/sessionComposerStore";

interface ComposerOptions {
  initialModel?: string;
  initialThinking?: ThinkingLevel;
  defaultThinking: ThinkingLevel;
}

const emptyDraft = stagedContent();

function useComposerTarget(id: string) {
  const store = composerStore();
  return useMemo(() => composerTarget(id, store), [id, store]);
}

function useDraftActions(target: ComposerTarget, draft: typeof emptyDraft) {
  const setters = useMemo(
    () => ({
      beginSubmission: (text: string) => actions.beginSubmission(target, text),
      finishSubmission: (id: string) => actions.finishSubmission(target, id),
      setDraft: (v: string) => actions.setDraft(target, v),
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
    [target]
  );

  return { ...setters, clearSent: () => actions.clearSent(target, draft) };
}

export function useHomeComposer() {
  return useComposerDraft(HOME_COMPOSER_ID);
}

export function useComposerDraft(id: string) {
  const target = useComposerTarget(id);
  const draft = useStore(target.store, (s) => s.pendingContent[id] ?? emptyDraft);
  return { ...draft, ...useDraftActions(target, draft) };
}

export function useSessionComposer(
  id: string,
  { initialModel, initialThinking, defaultThinking }: ComposerOptions
) {
  const target = useComposerTarget(id);
  const seedThinking = initialThinking ?? defaultThinking;
  const initial = useMemo(
    () => emptyComposer(initialModel, seedThinking),
    [initialModel, seedThinking]
  );
  useEffect(() => actions.seedIfAbsent(target, initial), [target, initial]);
  const state = useStore(target.store, (s) => s.composers[id] ?? initial);
  const draftActions = useDraftActions(target, state);
  const setters = useMemo(
    () => ({
      pickModel: (model: string, level: ThinkingLevel) => actions.pickModel(target, model, level),
      setModel: (v: string, levels: readonly ThinkingLevel[] | undefined) =>
        actions.setModel(target, v, levels, defaultThinking),
      setThinkingLevel: (level: ThinkingLevel) => actions.setThinkingLevel(target, level),
      togglePlanMode: () => actions.togglePlanMode(target),
    }),
    [target, defaultThinking]
  );
  return { ...state, ...draftActions, ...setters };
}
