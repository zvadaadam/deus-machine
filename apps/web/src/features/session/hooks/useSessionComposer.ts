/**
 * useSessionComposer — React binding for a single session's composer slice.
 *
 * Seeds the store on first mount for this sessionId, subscribes to the
 * slice so the component re-renders on change, and returns the state plus
 * a bag of sessionId-bound setters. The bag is memoised so children that
 * take setters as deps don't see a new reference every render.
 *
 * `defaultThinking` comes from user settings (Settings → AI) — used as
 * both the seed value and as the clamp target when switching models.
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
  defaultThinking: ThinkingLevel;
}

export interface SessionComposerActions {
  setDraft: (draft: string) => void;
  appendDraft: (text: string) => void;
  setModel: (model: string) => void;
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
  { initialModel, defaultThinking }: UseSessionComposerOptions
): UseSessionComposerReturn {
  const fallbackComposer = useMemo(
    () => emptyComposer(initialModel, defaultThinking),
    [initialModel, defaultThinking]
  );

  useEffect(() => {
    sessionComposerActions.seedIfAbsent(sessionId, emptyComposer(initialModel, defaultThinking));
  }, [sessionId, initialModel, defaultThinking]);

  const state = useSessionComposerStore((s) => s.composers[sessionId] ?? fallbackComposer);

  // Bind sessionId into each action once per mount. defaultThinking goes
  // into setModel's clamp fallback — changes to it re-create the bag.
  const actions = useMemo<SessionComposerActions>(
    () => ({
      setDraft: (v) => sessionComposerActions.setDraft(sessionId, v),
      appendDraft: (v) => sessionComposerActions.appendDraft(sessionId, v),
      setModel: (v) => sessionComposerActions.setModel(sessionId, v, defaultThinking),
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
