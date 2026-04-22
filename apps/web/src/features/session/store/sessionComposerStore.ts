/**
 * Session Composer Store — per-session staged content for the chat input.
 *
 * Composer state belongs to a *session*, not to whichever React surface
 * happens to render the input (main chat, modal, focus-mode overlay). Two
 * surfaces rendering the same session must see identical state — hence
 * one store keyed by sessionId.
 *
 * State is in-memory only (no persist middleware): drafts stay out of
 * localStorage, and state survives component remount within a session.
 * Enter focus mode, main chat unmounts, everything staged remains; exit
 * focus mode, main chat remounts with the same values.
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import {
  clampThinkingLevel,
  getAgentHarnessForModel,
  getModelId,
  type ThinkingLevel,
} from "@/shared/agents";
import type { InspectedElement } from "../ui/InspectedElementCard";
import type { FileMention } from "../ui/FileMentionCard";
import type { SkillMention } from "../ui/SkillMentionCard";
import type { ImageAttachment } from "../lib/imageAttachments";

export interface PastedText {
  id: string;
  content: string;
}

export interface ComposerState {
  draft: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  planModeEnabled: boolean;
  // Staged content — everything the user has added for the next message.
  pastedTexts: PastedText[];
  inspectedElements: InspectedElement[];
  fileMentions: FileMention[];
  skillMentions: SkillMention[];
  imageAttachments: ImageAttachment[];
}

interface State {
  composers: Record<string, ComposerState>;
}

export const useSessionComposerStore = create<State>()(
  devtools(
    immer(() => ({ composers: {} })),
    { name: "session-composer-store", enabled: import.meta.env.DEV }
  )
);

/** Empty composer, used both to seed new sessions and as the first-render
 *  selector fallback before the seed effect fires. */
export function emptyComposer(initialModel: string, defaultThinking: ThinkingLevel): ComposerState {
  return {
    draft: "",
    model: initialModel,
    thinkingLevel: defaultThinking,
    planModeEnabled: false,
    pastedTexts: [],
    inspectedElements: [],
    fileMentions: [],
    skillMentions: [],
    imageAttachments: [],
  };
}

/** Apply an Immer recipe to a session's composer slice.
 *  No-op if the session hasn't been seeded. The devtools label makes
 *  each action show up distinctly in Redux DevTools. */
function mutate(sessionId: string, recipe: (c: ComposerState) => void, label: string): void {
  useSessionComposerStore.setState(
    (s) => {
      const slice = s.composers[sessionId];
      if (slice) recipe(slice);
    },
    false,
    `composer/${label}`
  );
}

/**
 * Stable, React-free actions — callable from anywhere. Most actions are
 * one-line Immer recipes; the helper above handles the exists-check and
 * the devtools label.
 */
export const sessionComposerActions = {
  seedIfAbsent: (sessionId: string, initial: ComposerState): void => {
    if (useSessionComposerStore.getState().composers[sessionId]) return;
    useSessionComposerStore.setState(
      (s) => {
        s.composers[sessionId] = initial;
      },
      false,
      "composer/seed"
    );
  },

  setDraft: (sid: string, draft: string) =>
    mutate(
      sid,
      (c) => {
        c.draft = draft;
      },
      "setDraft"
    ),

  /** Append text to the draft, inserting a blank-line separator if needed.
   *  Used by cross-panel producers (browser inspector, diff reviewer). */
  appendDraft: (sid: string, text: string) =>
    mutate(
      sid,
      (c) => {
        c.draft += (c.draft.trim() ? "\n\n" : "") + text;
      },
      "appendDraft"
    ),

  /** Switch model; if the new model doesn't support the current thinking
   *  level, snap to the user's configured default. */
  setModel: (sid: string, model: string, fallbackThinking: ThinkingLevel) =>
    mutate(
      sid,
      (c) => {
        c.model = model;
        c.thinkingLevel = clampThinkingLevel(
          c.thinkingLevel,
          getAgentHarnessForModel(model),
          getModelId(model),
          fallbackThinking
        );
      },
      "setModel"
    ),

  setThinkingLevel: (sid: string, level: ThinkingLevel) =>
    mutate(
      sid,
      (c) => {
        c.thinkingLevel = level;
      },
      "setThinkingLevel"
    ),

  togglePlanMode: (sid: string) =>
    mutate(
      sid,
      (c) => {
        c.planModeEnabled = !c.planModeEnabled;
      },
      "togglePlanMode"
    ),

  addPastedText: (sid: string, content: string) =>
    mutate(
      sid,
      (c) => {
        c.pastedTexts.push({ id: crypto.randomUUID(), content });
      },
      "addPastedText"
    ),

  removePastedText: (sid: string, id: string) =>
    mutate(
      sid,
      (c) => {
        c.pastedTexts = c.pastedTexts.filter((p) => p.id !== id);
      },
      "removePastedText"
    ),

  addInspectedElement: (sid: string, element: Omit<InspectedElement, "id">) =>
    mutate(
      sid,
      (c) => {
        c.inspectedElements.push({ ...element, id: crypto.randomUUID() });
      },
      "addInspectedElement"
    ),

  removeInspectedElement: (sid: string, id: string) =>
    mutate(
      sid,
      (c) => {
        c.inspectedElements = c.inspectedElements.filter((el) => el.id !== id);
      },
      "removeInspectedElement"
    ),

  addFileMention: (sid: string, mention: Omit<FileMention, "id">) =>
    mutate(
      sid,
      (c) => {
        c.fileMentions.push({ ...mention, id: crypto.randomUUID() });
      },
      "addFileMention"
    ),

  removeFileMention: (sid: string, id: string) =>
    mutate(
      sid,
      (c) => {
        c.fileMentions = c.fileMentions.filter((fm) => fm.id !== id);
      },
      "removeFileMention"
    ),

  addSkillMention: (sid: string, mention: Omit<SkillMention, "id">) =>
    mutate(
      sid,
      (c) => {
        c.skillMentions.push({ ...mention, id: crypto.randomUUID() });
      },
      "addSkillMention"
    ),

  removeSkillMention: (sid: string, id: string) =>
    mutate(
      sid,
      (c) => {
        c.skillMentions = c.skillMentions.filter((m) => m.id !== id);
      },
      "removeSkillMention"
    ),

  addImageAttachments: (sid: string, attachments: ImageAttachment[]) => {
    if (attachments.length === 0) return;
    mutate(
      sid,
      (c) => {
        c.imageAttachments.push(...attachments);
      },
      "addImageAttachments"
    );
  },

  removeImageAttachment: (sid: string, id: string) =>
    mutate(
      sid,
      (c) => {
        c.imageAttachments = c.imageAttachments.filter((a) => a.id !== id);
      },
      "removeImageAttachment"
    ),

  /** Clear draft text only — keep model/thinking/plan. */
  clearDraft: (sid: string) =>
    mutate(
      sid,
      (c) => {
        c.draft = "";
      },
      "clearDraft"
    ),

  /** Clear all staged content on successful send; keep model/thinking/plan. */
  clearContent: (sid: string) =>
    mutate(
      sid,
      (c) => {
        c.draft = "";
        c.pastedTexts = [];
        c.inspectedElements = [];
        c.fileMentions = [];
        c.skillMentions = [];
        c.imageAttachments = [];
      },
      "clearContent"
    ),

  /** Remove the session's entry so the store doesn't accumulate stale keys.
   *  Called when a chat tab is closed. */
  discard: (sid: string) =>
    useSessionComposerStore.setState(
      (s) => {
        delete s.composers[sid];
      },
      false,
      "composer/discard"
    ),
};
