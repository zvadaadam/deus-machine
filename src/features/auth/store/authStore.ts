import { create } from "zustand";

interface AuthUIState {
  loginInProgress: boolean;
  setLoginInProgress: (inProgress: boolean) => void;
}

export const useAuthStore = create<AuthUIState>((set) => ({
  loginInProgress: false,
  setLoginInProgress: (inProgress) => set({ loginInProgress: inProgress }),
}));
