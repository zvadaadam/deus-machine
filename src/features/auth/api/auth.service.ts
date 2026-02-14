import { invoke } from "@/platform/tauri";
import type { AuthStatus } from "../types";

export const AuthService = {
  checkStatus: () => invoke<AuthStatus>("auth_check_status"),

  startLogin: () => invoke<void>("auth_start_login"),

  logout: () => invoke<void>("auth_logout"),
};
