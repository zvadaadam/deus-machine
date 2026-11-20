/**
 * useSessionComposer — React binding for a single session's composer slice.
 *
 * Seeds the store on first mount for this sessionId, subscribes to the
 * slice so the component re-renders on change, and returns the state plus
 * a bag of sessionId-bound setters. The bag is memoised so children that
 * take setters as deps don't see a new reference every render.
 *
 * `defaultThinking` comes from user settings (Settings → AI): the clamp
 * target when switching models, and the seed when `initialThinking` (the
 * level a reopened chat ran last) is absent.
 */

import { useEffect, useMemo } from "react";
import type { ThinkingLevel } from "@/shared/agents";
import type { InspectedElement } from "../ui/InspectedElementCard";
import type { FileMention } from "../ui/FileMentionCard";
import type { SkillMention } from "../ui/SkillMentionCard";
import type { ImageAttachment } from "../lib/imageAttachments";
import {
  emptyComposer,
  sessionComposerActions,
  useSessionComposerStore,
  type ComposerState,
} from "../store/sessionComposerStore";

interface UseSessionComposerOptions {
  initialModel: string;
  initialThinking?: ThinkingLevel;
  defaultThinking: ThinkingLevel;
}

export interface SessionComposerActions {
  setDraft: (draft: string) => void;
  appendDraft: (text: string) => void;
  /** `levels`: the thinking levels the model offers (useModelLists). */
  /** `levels`: the new model's, to fit the level to; none while its list is not live. */
  setModel: (model: string, levels: readonly ThinkingLevel[] | undefined) => void;
  setThinkingLevel: (level: string) => void;
  togglePlanMode: () => void;
  addPastedText: (content: string) => void;
  removePastedText: (id: string) => void;
  addInspectedElement: (element: Omit<InspectedElement, "id">) => void;
  removeInspectedElement: (id: string) => void;
  addFileMention: (mention: Omit<FileMention, "id">) => void;
  removeFileMention: (id: string) => void;
  addSkillMention: (mention: Omit<SkillMention, "id">) => void;
  removeSkillMention: (id: string) => void;
  addImageAttachments: (attachments: ImageAttachment[]) => void;
  removeImageAttachment: (id: string) => void;
  clearDraft: () => void;
  clearContent: () => void;
}

export type UseSessionComposerReturn = ComposerState & SessionComposerActions;

export function useSessionComposer(
  sessionId: string,
  { initialModel, initialThinking, defaultThinking }: UseSessionComposerOptions
): UseSessionComposerReturn {
  const seedThinking = initialThinking ?? defaultThinking;
  const fallbackComposer = useMemo(
    () => emptyComposer(initialModel, seedThinking),
    [initialModel, seedThinking]
  );

  useEffect(() => {
    sessionComposerActions.seedIfAbsent(sessionId, emptyComposer(initialModel, seedThinking));
  }, [sessionId, initialModel, seedThinking]);

  const state = useSessionComposerStore((s) => s.composers[sessionId] ?? fallbackComposer);

  // Bind sessionId into each action once per mount. defaultThinking goes
  // into setModel's clamp fallback — changes to it re-create the bag.
  const actions = useMemo<SessionComposerActions>(
    () => ({
      setDraft: (v) => sessionComposerActions.setDraft(sessionId, v),
      appendDraft: (v) => sessionComposerActions.appendDraft(sessionId, v),
      setModel: (v, levels) =>
        sessionComposerActions.setModel(sessionId, v, levels, defaultThinking),
      setThinkingLevel: (v) =>
        sessionComposerActions.setThinkingLevel(sessionId, v as ThinkingLevel),
      togglePlanMode: () => sessionComposerActions.togglePlanMode(sessionId),
      addPastedText: (v) => sessionComposerActions.addPastedText(sessionId, v),
      removePastedText: (id) => sessionComposerActions.removePastedText(sessionId, id),
      addInspectedElement: (v) => sessionComposerActions.addInspectedElement(sessionId, v),
      removeInspectedElement: (id) => sessionComposerActions.removeInspectedElement(sessionId, id),
      addFileMention: (v) => sessionComposerActions.addFileMention(sessionId, v),
      removeFileMention: (id) => sessionComposerActions.removeFileMention(sessionId, id),
      addSkillMention: (v) => sessionComposerActions.addSkillMention(sessionId, v),
      removeSkillMention: (id) => sessionComposerActions.removeSkillMention(sessionId, id),
      addImageAttachments: (v) => sessionComposerActions.addImageAttachments(sessionId, v),
      removeImageAttachment: (id) => sessionComposerActions.removeImageAttachment(sessionId, id),
      clearDraft: () => sessionComposerActions.clearDraft(sessionId),
      clearContent: () => sessionComposerActions.clearContent(sessionId),
    }),
    [sessionId, defaultThinking]
  );

  return { ...state, ...actions };
}
