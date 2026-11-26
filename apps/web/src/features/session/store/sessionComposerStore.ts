/** Drafts and notes survive reload under the runtime's host and account, while pictures, pasted cards and oversized text stay in memory. */
import { uuidv7 } from "@shared/lib/uuid";
import { createStore } from "zustand";
import { z } from "zod";
import { createJSONStorage, persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { QueryClient } from "@tanstack/react-query";
import { windowStorage } from "@/shared/stores/windowStorage";
import { runtimeForQueryClient } from "@/platform/ws/runtime-client";
import { queryClient } from "@/shared/api/queryClient";
import { fitThinkingLevel, type ThinkingLevel } from "@/shared/agents";
import type { InspectedElement } from "../ui/InspectedElementCard";
import type { FileMention } from "../ui/FileMentionCard";
import type { SkillMention } from "../ui/SkillMentionCard";
import { processImageFiles, type ImageAttachment } from "../lib/imageAttachments";

// Home pastes into its textarea. One pasted document must leave room for other chats to save.
const MAX_STORED_DRAFT_LENGTH = 100_000;

function storedObjects<T extends object>() {
  return z
    .array(z.custom<T>((item) => item !== null && typeof item === "object" && !Array.isArray(item)))
    .default([]);
}
const count = z.number().int().nonnegative().default(0);
const storedRow = z.object({
  draft: z.string().default(""),
  pendingSubmission: z.object({ id: z.uuid(), text: z.string() }).optional(),
  fileMentions: storedObjects<FileMention>(),
  skillMentions: storedObjects<SkillMention>(),
  inspectedElements: storedObjects<InspectedElement>(),
  missingPictures: count,
  missingPastedTexts: count,
});
type KeptDraft = z.infer<typeof storedRow>;
interface StagedContent extends KeptDraft {
  pastedTexts: { id: string; content: string }[];
  imageAttachments: ImageAttachment[];
}

export function stagedContent(row: KeptDraft = storedRow.parse({})): StagedContent {
  return { ...row, pastedTexts: [], imageAttachments: [] };
}

interface ComposerState extends StagedContent {
  /** An explicit pick. History and list defaults are read when the chat is shown. */
  model?: string;
  thinkingLevel: ThinkingLevel;
  planModeEnabled: boolean;
}

interface State {
  composers: Record<string, ComposerState>;
  // Cross-panel and restored drafts may arrive before history establishes the model.
  pendingContent: Record<string, StagedContent>;
}

export function emptyComposer(
  model: string | undefined,
  thinkingLevel: ThinkingLevel
): ComposerState {
  return { ...stagedContent(), model, thinkingLevel, planModeEnabled: false };
}

function hasDraft(row: KeptDraft) {
  const notes = row.fileMentions.length + row.skillMentions.length + row.inspectedElements.length;
  return Boolean(
    row.pendingSubmission || row.draft || notes || row.missingPictures || row.missingPastedTexts
  );
}

const storedRows = z.object({
  pendingContent: z.record(z.string(), storedRow.optional().catch(undefined)),
});

function createDraftStore(name: string) {
  return createStore<State>()(
    persist(
      immer((): State => ({ composers: {}, pendingContent: {} })),
      {
        name,
        storage: createJSONStorage(() => windowStorage),
        partialize({ composers, pendingContent }) {
          const rows: Record<string, KeptDraft> = {};
          for (const [id, content] of Object.entries({ ...pendingContent, ...composers })) {
            const oversized = content.draft.length > MAX_STORED_DRAFT_LENGTH;
            const row = {
              draft: oversized ? "" : content.draft,
              pendingSubmission: content.pendingSubmission,
              fileMentions: content.fileMentions,
              skillMentions: content.skillMentions,
              inspectedElements: content.inspectedElements,
              missingPictures: content.missingPictures + content.imageAttachments.length,
              missingPastedTexts:
                content.missingPastedTexts + content.pastedTexts.length + (oversized ? 1 : 0),
            };
            if (hasDraft(row)) rows[id] = row;
          }
          return { pendingContent: rows };
        },
        merge(saved, state) {
          const pendingContent: State["pendingContent"] = {};
          const rows = storedRows.safeParse(saved);
          for (const [id, row] of Object.entries(rows.data?.pendingContent ?? {})) {
            if (row && hasDraft(row)) pendingContent[id] = stagedContent(row);
          }
          return { ...state, pendingContent };
        },
      }
    )
  );
}

export type DraftStore = ReturnType<typeof createDraftStore>;
export const HOME_COMPOSER_ID = "home";
const scopes = new Map<string, DraftStore>();
export function composerStore(cache: QueryClient = queryClient): DraftStore {
  const identity = runtimeForQueryClient(cache)?.identity;
  const key = "composer-drafts:" + JSON.stringify([identity?.host, identity?.account]);
  let store = scopes.get(key);
  if (!store) {
    store = createDraftStore(key);
    scopes.set(key, store);
  }
  return store;
}

/** Capture the owner before a send or file read can outlive the current host. */
export const composerTarget = (id: string, store = composerStore()) => ({ id, store });
export type ComposerTarget = ReturnType<typeof composerTarget>;
type Target = string | ComposerTarget;
const resolve = (target: Target) => (typeof target === "string" ? composerTarget(target) : target);

// A start can finish while FileReader converts a dropped screenshot. The
// existing move also hands these reads to the chat. Discard cancels them.
const readingFiles = new Set<ComposerTarget>();
export async function attachImageFiles(target: Target, files: File[]): Promise<boolean> {
  const read = { ...resolve(target) };
  readingFiles.add(read);
  try {
    const attachments = await processImageFiles(files);
    if (!attachments.length || !readingFiles.has(read)) return false;
    edit(read, (content) => {
      content.imageAttachments.push(...attachments);
    });
    return true;
  } finally {
    readingFiles.delete(read);
  }
}

function edit(target: Target, recipe: (c: StagedContent) => void) {
  const { id, store } = resolve(target);
  store.setState((s) => {
    const content = s.composers[id] ?? (s.pendingContent[id] ??= stagedContent());
    recipe(content);
  });
}
function editSettings(target: Target, recipe: (c: ComposerState) => void) {
  const { id, store } = resolve(target);
  store.setState((s) => {
    if (s.composers[id]) recipe(s.composers[id]);
  });
}

const appendText = (draft: string, text: string) => draft + (draft.trim() ? "\n\n" : "") + text;
function withContent<T extends StagedContent>(base: T, extra: StagedContent): T {
  return {
    ...base,
    draft: extra.draft ? appendText(base.draft, extra.draft) : base.draft,
    pastedTexts: [...base.pastedTexts, ...extra.pastedTexts],
    inspectedElements: [...base.inspectedElements, ...extra.inspectedElements],
    fileMentions: [...base.fileMentions, ...extra.fileMentions],
    skillMentions: [...base.skillMentions, ...extra.skillMentions],
    imageAttachments: [...base.imageAttachments, ...extra.imageAttachments],
    missingPictures: base.missingPictures + extra.missingPictures,
    missingPastedTexts: base.missingPastedTexts + extra.missingPastedTexts,
  };
}
function unsent<T extends { id: string }>(current: T[], sent: T[]): T[] {
  const ids = new Set(sent.map((item) => item.id));
  return current.filter((item) => !ids.has(item.id));
}

export const sessionComposerActions = {
  seedIfAbsent(target: Target, initial: ComposerState) {
    const { id, store } = resolve(target);
    if (store.getState().composers[id]) return;
    store.setState((s) => {
      const pending = s.pendingContent[id];
      s.composers[id] = pending ? withContent(initial, pending) : initial;
      delete s.pendingContent[id];
    });
  },

  /** A start page's draft goes to its first chat once, including when the
   * start finished while this window was closed. History owns the settings
   * of a chat that has already been spoken to. */
  move(from: string, to: string, { settings = true } = {}) {
    const store = composerStore();
    const { composers, pendingContent } = store.getState();
    if (from === to) return;
    for (const read of readingFiles) {
      if (read.store === store && read.id === from) read.id = to;
    }
    if (!(composers[from] || pendingContent[from])) return;
    store.setState((s) => {
      const source = s.composers[from] ?? s.pendingContent[from];
      if (s.composers[to]) {
        s.composers[to] = withContent(s.composers[to], source);
      } else if (settings && s.composers[from]) {
        s.composers[to] = s.pendingContent[to]
          ? withContent(s.composers[from], s.pendingContent[to])
          : s.composers[from];
        delete s.pendingContent[to];
      } else {
        s.pendingContent[to] = withContent(s.pendingContent[to] ?? stagedContent(), source);
      }
      delete s.composers[from];
      delete s.pendingContent[from];
    });
  },

  setDraft: (key: Target, draft: string) =>
    edit(key, (c) => {
      c.draft = draft;
    }),
  appendDraft: (key: Target, text: string) =>
    edit(key, (c) => {
      c.draft = appendText(c.draft, text);
    }),
  pickModel(target: Target, model: string, thinkingLevel: ThinkingLevel) {
    const { store, id } = resolve(target);
    if (!store.getState().composers[id]) {
      sessionComposerActions.seedIfAbsent(target, emptyComposer(model, thinkingLevel));
      return;
    }
    editSettings(target, (composer) => {
      composer.model = model;
      composer.thinkingLevel = thinkingLevel;
    });
  },
  setModel: (
    key: Target,
    model: string,
    levels: readonly ThinkingLevel[] | undefined,
    fallback: ThinkingLevel
  ) =>
    editSettings(key, (c) => {
      c.model = model;
      if (levels) c.thinkingLevel = fitThinkingLevel(c.thinkingLevel, levels, fallback);
    }),
  setThinkingLevel: (key: Target, level: ThinkingLevel) =>
    editSettings(key, (c) => {
      c.thinkingLevel = level;
    }),
  togglePlanMode: (key: Target) =>
    editSettings(key, (c) => {
      c.planModeEnabled = !c.planModeEnabled;
    }),
  leavePlanMode: (key: Target) =>
    editSettings(key, (c) => {
      c.planModeEnabled = false;
    }),

  addPastedText: (key: Target, content: string) =>
    edit(key, (c) => {
      c.pastedTexts.push({ id: crypto.randomUUID(), content });
    }),
  removePastedText: (key: Target, id: string) =>
    edit(key, (c) => {
      c.pastedTexts = c.pastedTexts.filter((p) => p.id !== id);
    }),
  addInspectedElement: (key: Target, element: Omit<InspectedElement, "id">) =>
    edit(key, (c) => {
      c.inspectedElements.push({ ...element, id: crypto.randomUUID() });
    }),
  removeInspectedElement: (key: Target, id: string) =>
    edit(key, (c) => {
      c.inspectedElements = c.inspectedElements.filter((p) => p.id !== id);
    }),
  addFileMention: (key: Target, mention: Omit<FileMention, "id">) =>
    edit(key, (c) => {
      c.fileMentions.push({ ...mention, id: crypto.randomUUID() });
    }),
  removeFileMention: (key: Target, id: string) =>
    edit(key, (c) => {
      c.fileMentions = c.fileMentions.filter((p) => p.id !== id);
    }),
  addSkillMention: (key: Target, mention: Omit<SkillMention, "id">) =>
    edit(key, (c) => {
      c.skillMentions.push({ ...mention, id: crypto.randomUUID() });
    }),
  removeSkillMention: (key: Target, id: string) =>
    edit(key, (c) => {
      c.skillMentions = c.skillMentions.filter((p) => p.id !== id);
    }),

  removeImageAttachment: (key: Target, id: string) =>
    edit(key, (c) => {
      c.imageAttachments = c.imageAttachments.filter((p) => p.id !== id);
    }),
  dismissMissingAttachments: (key: Target) =>
    edit(key, (c) => {
      c.missingPictures = 0;
      c.missingPastedTexts = 0;
    }),

  beginSubmission(key: Target, text: string) {
    let id: string;
    edit(key, (c) => {
      if (c.pendingSubmission?.text !== text) c.pendingSubmission = { id: uuidv7(), text };
      id = c.pendingSubmission.id;
    });
    return id!;
  },
  finishSubmission(key: Target, id: string) {
    let finished = false;
    edit(key, (c) => {
      const pending = c.pendingSubmission;
      if (pending?.id !== id) return;
      if (c.draft.startsWith(pending.text)) c.draft = c.draft.slice(pending.text.length);
      delete c.pendingSubmission;
      finished = true;
    });
    return finished;
  },

  clearSent: (key: Target, sent: StagedContent) =>
    edit(key, (c) => {
      if (c.draft.startsWith(sent.draft)) c.draft = c.draft.slice(sent.draft.length);
      c.pastedTexts = unsent(c.pastedTexts, sent.pastedTexts);
      c.fileMentions = unsent(c.fileMentions, sent.fileMentions);
      c.skillMentions = unsent(c.skillMentions, sent.skillMentions);
      c.inspectedElements = unsent(c.inspectedElements, sent.inspectedElements);
      c.imageAttachments = unsent(c.imageAttachments, sent.imageAttachments);
      c.missingPictures = Math.max(0, c.missingPictures - sent.missingPictures);
      c.missingPastedTexts = Math.max(0, c.missingPastedTexts - sent.missingPastedTexts);
    }),

  discard(id: string) {
    const store = composerStore();
    for (const read of readingFiles) {
      if (read.store === store && read.id === id) readingFiles.delete(read);
    }
    store.setState((s) => {
      delete s.composers[id];
      delete s.pendingContent[id];
    });
  },
};
