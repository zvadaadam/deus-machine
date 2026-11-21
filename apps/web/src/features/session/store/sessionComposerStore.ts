/**
 * To survive reload and relaunch, drafts keep plain content and picture counts in this
 * window's storage under the runtime's host and account, while pictures stay in memory.
 */
import { createStore, useStore } from "zustand";
import { shallow } from "zustand/shallow";
import { createJSONStorage, persist, type PersistStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { QueryClient } from "@tanstack/react-query";
import { capabilities } from "@/platform/capabilities";
import { runtimeForQueryClient } from "@/platform/ws/runtime-client";
import { queryClient } from "@/shared/api/queryClient";
import { fitThinkingLevel, type ThinkingLevel } from "@/shared/agents";
import type { InspectedElement } from "../ui/InspectedElementCard";
import type { FileMention } from "../ui/FileMentionCard";
import type { SkillMention } from "../ui/SkillMentionCard";
import { processImageFiles, type ImageAttachment } from "../lib/imageAttachments";

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
  missingPictures: number;
}

export interface ComposerState extends StagedContent {
  model: string;
  thinkingLevel: ThinkingLevel;
  planModeEnabled: boolean;
}

interface State {
  composers: Record<string, ComposerState>;
  // Cross-panel and restored drafts may arrive before history establishes the model.
  pendingContent: Record<string, StagedContent>;
}

const emptyContent = (): StagedContent => ({
  draft: "",
  pastedTexts: [],
  inspectedElements: [],
  fileMentions: [],
  skillMentions: [],
  imageAttachments: [],
  missingPictures: 0,
});

export function emptyComposer(model: string, thinkingLevel: ThinkingLevel): ComposerState {
  return { ...emptyContent(), model, thinkingLevel, planModeEnabled: false };
}

const NO_PICTURES: ImageAttachment[] = [];

function keptDrafts({ composers, pendingContent }: State): Pick<State, "pendingContent"> {
  const drafts: Record<string, StagedContent> = {};
  for (const [id, content] of Object.entries({ ...pendingContent, ...composers })) {
    const {
      draft,
      pastedTexts,
      inspectedElements,
      fileMentions,
      skillMentions,
      imageAttachments,
      missingPictures,
    } = content;
    if (
      draft ||
      pastedTexts.length ||
      inspectedElements.length ||
      fileMentions.length ||
      skillMentions.length ||
      imageAttachments.length ||
      missingPictures
    ) {
      drafts[id] = {
        draft,
        pastedTexts,
        inspectedElements,
        fileMentions,
        skillMentions,
        imageAttachments: NO_PICTURES,
        missingPictures: missingPictures + imageAttachments.length,
      };
    }
  }
  return { pendingContent: drafts };
}

function createDraftStore(name: string) {
  type Kept = ReturnType<typeof keptDrafts>;
  const json = createJSONStorage<Kept>(() =>
    capabilities.singleWindow ? localStorage : sessionStorage
  );
  let durable: State["pendingContent"] = {};
  let previous = durable;
  const storage: PersistStorage<Kept> = {
    getItem: (key) => json?.getItem(key) ?? null,
    removeItem: (key) => json?.removeItem(key),
    setItem(key, { state: { pendingContent }, version }) {
      function write(drafts: State["pendingContent"]) {
        try {
          json?.setItem(key, { state: { pendingContent: drafts }, version });
          durable = drafts;
          return true;
        } catch {
          return false;
        }
      }
      // Compose the next write from the last versions that fit and the edits
      // made now. Typing elsewhere must not serialize a rejected paste again.
      const edits = Object.entries(pendingContent).filter(
        ([id, draft]) => !shallow(previous[id], draft)
      );
      const removed = Object.keys(durable).filter((id) => !(id in pendingContent));
      previous = pendingContent;
      if (!edits.length && !removed.length) return;
      const kept = { ...durable };
      for (const id of removed) delete kept[id];
      if (write({ ...kept, ...Object.fromEntries(edits) }) || !edits.length) return;
      // If a combined update exceeded quota, still save its removals and
      // any smaller edits, leaving the oversized content in memory.
      if (removed.length) write(kept);
      if (edits.length > 1) {
        for (const [id, draft] of edits) write({ ...durable, [id]: draft });
      }
    },
  };
  return createStore<State>()(
    persist(
      immer(() => ({ composers: {}, pendingContent: {} })),
      {
        name,
        storage,
        partialize: keptDrafts,
        merge: (saved, state) => {
          durable = (saved as Kept | undefined)?.pendingContent ?? {};
          previous = durable;
          return { ...state, pendingContent: durable };
        },
      }
    )
  );
}

export type DraftStore = ReturnType<typeof createDraftStore>;
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

export function useSessionComposerStore<T>(select: (state: State) => T): T {
  return useStore(composerStore(), select);
}
useSessionComposerStore.getState = () => composerStore().getState();

/** Capture the owner before a send or file read can outlive the current host. */
export const composerTarget = (id: string, store = composerStore()) => ({ id, store });
type Target = string | ReturnType<typeof composerTarget>;
const resolve = (target: Target) => (typeof target === "string" ? composerTarget(target) : target);

// A start can finish while FileReader converts a dropped screenshot. The
// existing move also hands these reads to the chat. Discard cancels them.
const readingFiles = new Set<ReturnType<typeof composerTarget>>();
export async function attachImageFiles(target: Target, files: File[]): Promise<void> {
  const read = { ...resolve(target) };
  readingFiles.add(read);
  try {
    const attachments = await processImageFiles(files);
    if (readingFiles.has(read)) sessionComposerActions.addImageAttachments(read, attachments);
  } finally {
    readingFiles.delete(read);
  }
}

function edit(target: Target, recipe: (c: StagedContent) => void) {
  const { id, store } = resolve(target);
  store.setState((s) => {
    const content = s.composers[id] ?? (s.pendingContent[id] ??= emptyContent());
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
        s.pendingContent[to] = withContent(s.pendingContent[to] ?? emptyContent(), source);
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

  addImageAttachments: (key: Target, attachments: ImageAttachment[]) => {
    if (attachments.length)
      edit(key, (c) => {
        c.imageAttachments.push(...attachments);
        c.missingPictures = 0;
      });
  },
  removeImageAttachment: (key: Target, id: string) =>
    edit(key, (c) => {
      c.imageAttachments = c.imageAttachments.filter((p) => p.id !== id);
    }),
  dismissMissingPictures: (key: Target) =>
    edit(key, (c) => {
      c.missingPictures = 0;
    }),

  clearSent: (key: Target, sent: StagedContent) =>
    edit(key, (c) => {
      if (c.draft.startsWith(sent.draft)) c.draft = c.draft.slice(sent.draft.length);
      c.pastedTexts = unsent(c.pastedTexts, sent.pastedTexts);
      c.fileMentions = unsent(c.fileMentions, sent.fileMentions);
      c.skillMentions = unsent(c.skillMentions, sent.skillMentions);
      c.inspectedElements = unsent(c.inspectedElements, sent.inspectedElements);
      c.imageAttachments = unsent(c.imageAttachments, sent.imageAttachments);
      c.missingPictures = Math.max(0, c.missingPictures - sent.missingPictures);
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
