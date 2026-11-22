// Each browser tab keeps its own state across reloads so a second tab cannot act on it too.
// The desktop has one window, so it keeps that state on the device across quits.
import type { StateStorage } from "zustand/middleware";
import { capabilities } from "@/platform/capabilities";

const storage = () => (capabilities.singleWindow ? localStorage : sessionStorage);

export const windowStorage: StateStorage = {
  getItem(name) {
    try {
      return storage().getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name, value) {
    try {
      storage().setItem(name, value);
    } catch {
      // Drafts and waiting messages share a quota. Drop only this store's old copy
      // so a sent message cannot return. An unsaved waiting message is lost on quit.
      windowStorage.removeItem(name);
    }
  },
  removeItem(name) {
    try {
      storage().removeItem(name);
    } catch {
      /* Storage is unavailable. */
    }
  },
};
