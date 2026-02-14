// -- Auth status returned by Tauri Keychain check --

export interface AuthStatus {
  authenticated: boolean;
  provider?: "google" | "github";
  user_email?: string;
  user_name?: string;
  user_avatar_url?: string;
}

// -- User object persisted in SQLite --

export interface User {
  id: string;

  // Identity (from OAuth)
  email: string;
  name: string | null;
  avatar_url: string | null;

  // Auth provider
  provider: "google" | "github";
  provider_user_id: string | null; // Google/GitHub user ID — for account linking

  // GitHub identity (separate from auth provider —
  // user might sign in with Google but still have GitHub repos)
  github_username: string | null;

  // Subscription
  plan: "free" | "pro" | "team";

  // Activity
  last_login_at: string;
  login_count: number;

  // Timestamps
  created_at: string;
  updated_at: string;
}
