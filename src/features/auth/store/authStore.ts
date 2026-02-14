import { create } from "zustand";

interface AuthUIState {
  loginInProgress: boolean;
  loginError: string | null;
  setLoginInProgress: (inProgress: boolean) => void;
  setLoginError: (error: string | null) => void;
}

export const useAuthStore = create<AuthUIState>((set) => ({
  loginInProgress: false,
  loginError: null,
  setLoginInProgress: (inProgress) => set({ loginInProgress: inProgress }),
  setLoginError: (error) => set({ loginError: error }),
}));
