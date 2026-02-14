-- Users table — stores authenticated user identity from OAuth.
--
-- The Keychain is the auth credential cache (fast, Rust-only).
-- This table is the canonical user record that backend + sidecar can read.
--
-- NOT YET ACTIVE — will be added to initDatabase() when ready.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

    -- Identity (from OAuth provider)
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    avatar_url TEXT,

    -- Auth provider
    provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
    provider_user_id TEXT,              -- Provider's user ID for account linking/dedup

    -- GitHub identity (separate from auth provider —
    -- user might sign in with Google but still use GitHub repos)
    github_username TEXT,

    -- Subscription
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),

    -- Activity
    last_login_at TEXT NOT NULL DEFAULT (datetime('now')),
    login_count INTEGER NOT NULL DEFAULT 1,

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auto-update trigger (matches production OpenDevs pattern)
CREATE TRIGGER IF NOT EXISTS update_users_updated_at
AFTER UPDATE ON users
BEGIN
    UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Index for email lookups (login upsert)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);


-- =============================================================
-- UPSERT query for login (insert or update on email match)
-- =============================================================
--
-- INSERT INTO users (email, name, avatar_url, provider, provider_user_id)
-- VALUES (?, ?, ?, ?, ?)
-- ON CONFLICT(email) DO UPDATE SET
--     name = excluded.name,
--     avatar_url = excluded.avatar_url,
--     provider = excluded.provider,
--     provider_user_id = excluded.provider_user_id,
--     last_login_at = datetime('now'),
--     login_count = login_count + 1;


-- =============================================================
-- FUTURE: Add user_id FK to existing tables (separate migration)
-- =============================================================
--
-- ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id);
-- ALTER TABLE workspaces ADD COLUMN user_id TEXT REFERENCES users(id);
-- CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
-- CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);
