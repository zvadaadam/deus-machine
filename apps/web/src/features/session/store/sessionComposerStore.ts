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

interface StagedContent {
  draft: string;
  pastedTexts: PastedText[];
  inspectedElements: InspectedElement[];
  fileMentions: FileMention[];
  skillMentions: SkillMention[];
  imageAttachments: ImageAttachment[];
}

export interface ComposerState extends StagedContent {
  model: string;
  thinkingLevel: ThinkingLevel;
  planModeEnabled: boolean;
}

interface State {
  composers: Record<string, ComposerState>;
  // Cross-panel content can arrive before history establishes the model.
  pendingContent: Record<string, StagedContent>;
}

export const useSessionComposerStore = create<State>()(
  devtools(
    immer(() => ({ composers: {}, pendingContent: {} })),
    { name: "session-composer-store", enabled: import.meta.env.DEV }
  )
);

/** Empty composer, used both to seed new sessions and as the first-render
 *  selector fallback before the seed effect fires. */
export function emptyComposer(initialModel: string, defaultThinking: ThinkingLevel): ComposerState {
  return {
    ...emptyContent(),
    model: initialModel,
    thinkingLevel: defaultThinking,
    planModeEnabled: false,
  };
}

function emptyContent(): StagedContent {
  return {
    draft: "",
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

/** Stage content independently of the model's one-time initialization. */
function mutateContent(sessionId: string, recipe: (c: StagedContent) => void, label: string): void {
  useSessionComposerStore.setState(
    (s) => {
      const content = s.composers[sessionId] ?? (s.pendingContent[sessionId] ??= emptyContent());
      recipe(content);
    },
    false,
    `composer/${label}`
  );
}

/**
 * Stable, React-free actions — callable from anywhere. Most actions are
 * one-line Immer recipes; the helpers distinguish initialized settings
 * from content that can be staged before mount.
 */
export const sessionComposerActions = {
  seedIfAbsent: (sessionId: string, initial: ComposerState): void => {
    if (useSessionComposerStore.getState().composers[sessionId]) return;
    useSessionComposerStore.setState(
      (s) => {
        const pending = s.pendingContent[sessionId];
        s.composers[sessionId] = pending
          ? {
              ...initial,
              draft: pending.draft ? appendText(initial.draft, pending.draft) : initial.draft,
              pastedTexts: [...initial.pastedTexts, ...pending.pastedTexts],
              inspectedElements: [...initial.inspectedElements, ...pending.inspectedElements],
              fileMentions: [...initial.fileMentions, ...pending.fileMentions],
              skillMentions: [...initial.skillMentions, ...pending.skillMentions],
              imageAttachments: [...initial.imageAttachments, ...pending.imageAttachments],
            }
          : initial;
        delete s.pendingContent[sessionId];
      },
      false,
      "composer/seed"
    );
  },

  setDraft: (sid: string, draft: string) =>
    mutateContent(
      sid,
      (c) => {
        c.draft = draft;
      },
      "setDraft"
    ),

  /** Append text to the draft, inserting a blank-line separator if needed.
   *  Used by cross-panel producers (browser inspector, diff reviewer). */
  appendDraft: (sid: string, text: string) =>
    mutateContent(
      sid,
      (c) => {
        c.draft = appendText(c.draft, text);
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
    mutateContent(
      sid,
      (c) => {
        c.pastedTexts.push({ id: crypto.randomUUID(), content });
      },
      "addPastedText"
    ),

  removePastedText: (sid: string, id: string) =>
    mutateContent(
      sid,
      (c) => {
        c.pastedTexts = c.pastedTexts.filter((p) => p.id !== id);
      },
      "removePastedText"
    ),

  addInspectedElement: (sid: string, element: Omit<InspectedElement, "id">) =>
    mutateContent(
      sid,
      (c) => {
        c.inspectedElements.push({ ...element, id: crypto.randomUUID() });
      },
      "addInspectedElement"
    ),

  removeInspectedElement: (sid: string, id: string) =>
    mutateContent(
      sid,
      (c) => {
        c.inspectedElements = c.inspectedElements.filter((el) => el.id !== id);
      },
      "removeInspectedElement"
    ),

  addFileMention: (sid: string, mention: Omit<FileMention, "id">) =>
    mutateContent(
      sid,
      (c) => {
        c.fileMentions.push({ ...mention, id: crypto.randomUUID() });
      },
      "addFileMention"
    ),

  removeFileMention: (sid: string, id: string) =>
    mutateContent(
      sid,
      (c) => {
        c.fileMentions = c.fileMentions.filter((fm) => fm.id !== id);
      },
      "removeFileMention"
    ),

  addSkillMention: (sid: string, mention: Omit<SkillMention, "id">) =>
    mutateContent(
      sid,
      (c) => {
        c.skillMentions.push({ ...mention, id: crypto.randomUUID() });
      },
      "addSkillMention"
    ),

  removeSkillMention: (sid: string, id: string) =>
    mutateContent(
      sid,
      (c) => {
        c.skillMentions = c.skillMentions.filter((m) => m.id !== id);
      },
      "removeSkillMention"
    ),

  addImageAttachments: (sid: string, attachments: ImageAttachment[]) => {
    if (attachments.length === 0) return;
    mutateContent(
      sid,
      (c) => {
        c.imageAttachments.push(...attachments);
      },
      "addImageAttachments"
    );
  },

  removeImageAttachment: (sid: string, id: string) =>
    mutateContent(
      sid,
      (c) => {
        c.imageAttachments = c.imageAttachments.filter((a) => a.id !== id);
      },
      "removeImageAttachment"
    ),

  /** Clear draft text only — keep model/thinking/plan. */
  clearDraft: (sid: string) =>
    mutateContent(
      sid,
      (c) => {
        c.draft = "";
      },
      "clearDraft"
    ),

  /** Clear all staged content on successful send; keep model/thinking/plan. */
  clearContent: (sid: string) =>
    mutateContent(
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
        delete s.pendingContent[sid];
      },
      false,
      "composer/discard"
    ),
};

function appendText(draft: string, text: string): string {
  return draft + (draft.trim() ? "\n\n" : "") + text;
}
