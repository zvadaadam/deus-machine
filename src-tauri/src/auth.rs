use serde::Serialize;
use std::sync::{Arc, Mutex};
use thiserror::Error;

const KEYCHAIN_SERVICE: &str = "com.conductor.app";

/// Typed auth errors — serialized as strings over IPC (Tauri v2 best practice).
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Keychain error ({key}): {detail}")]
    Keychain { key: String, detail: String },
    #[error("Failed to open browser: {0}")]
    Browser(String),
    #[error("Missing required identity fields (provider, email)")]
    MissingFields,
}

impl Serialize for AuthError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

/// Auth Manager
///
/// Manages user authentication state with macOS Keychain persistence.
/// Login is a one-time operation — once authenticated, identity is stored
/// permanently in Keychain (like Figma/Cursor). Users only see a login
/// screen on first launch.
///
/// Uses Arc<Mutex<>> internally so it can be cloned into the deep-link
/// callback closure while sharing the same underlying state.
#[derive(Clone)]
pub struct AuthManager {
    state: Arc<Mutex<AuthState>>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AuthState {
    pub authenticated: bool,
    pub provider: Option<String>,
    pub user_email: Option<String>,
    pub user_name: Option<String>,
    pub user_avatar_url: Option<String>,
    /// True only between auth_start_login and callback processing.
    /// Prevents unsolicited deep link callbacks from spoofing identity.
    #[serde(skip)]
    pub login_pending: bool,
    /// Random state parameter for OAuth CSRF protection.
    /// Generated in start_login, verified in the deep link callback.
    #[serde(skip)]
    pub pending_state: Option<String>,
}

impl AuthManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(AuthState::default())),
        }
    }

    /// Load stored identity from macOS Keychain on app startup.
    /// Returns true if a valid identity was found.
    pub fn load_from_keychain(&self) -> bool {
        let provider = Self::keychain_get("auth_provider");
        let email = Self::keychain_get("auth_email");

        // Must have at least provider and email to be considered authenticated
        if provider.is_none() || email.is_none() {
            return false;
        }

        let name = Self::keychain_get("auth_name");
        let avatar = Self::keychain_get("auth_avatar");

        let mut state = self.state.lock().unwrap();
        *state = AuthState {
            authenticated: true,
            provider,
            user_email: email,
            user_name: name,
            user_avatar_url: avatar,
            ..Default::default()
        };

        true
    }

    /// Persist user identity to macOS Keychain permanently.
    pub fn save_to_keychain(
        &self,
        provider: &str,
        email: &str,
        name: &str,
        avatar: &str,
    ) -> Result<(), AuthError> {
        Self::keychain_set("auth_provider", provider)?;
        Self::keychain_set("auth_email", email)?;
        Self::keychain_set("auth_name", name)?;
        Self::keychain_set("auth_avatar", avatar)?;

        let mut state = self.state.lock().unwrap();
        *state = AuthState {
            authenticated: true,
            provider: Some(provider.to_string()),
            user_email: Some(email.to_string()),
            user_name: Some(name.to_string()),
            user_avatar_url: Some(avatar.to_string()),
            ..Default::default()
        };

        println!(
            "[AUTH] Saved identity to Keychain: {} ({})",
            email, provider
        );
        Ok(())
    }

    /// Clear all auth data from Keychain and reset in-memory state.
    pub fn clear_keychain(&self) -> Result<(), AuthError> {
        // Delete silently — ignore errors if keys don't exist
        Self::keychain_delete("auth_provider");
        Self::keychain_delete("auth_email");
        Self::keychain_delete("auth_name");
        Self::keychain_delete("auth_avatar");

        let mut state = self.state.lock().unwrap();
        *state = AuthState::default();

        println!("[AUTH] Cleared identity from Keychain");
        Ok(())
    }

    /// Mark that a login flow has been initiated. Returns a state parameter
    /// to include in the auth URL for CSRF protection (per RFC 8252).
    pub fn start_login(&self) -> String {
        let state = Self::generate_state();
        let mut s = self.state.lock().unwrap();
        s.login_pending = true;
        s.pending_state = Some(state.clone());
        state
    }

    /// Check if a login flow is pending and verify the state parameter.
    /// Returns true if the deep link callback should be accepted.
    pub fn verify_callback(&self, received_state: Option<&str>) -> bool {
        let s = self.state.lock().unwrap();
        if !s.login_pending {
            return false;
        }
        matches!(
            (&s.pending_state, received_state),
            (Some(expected), Some(received)) if expected == received
        )
    }

    /// Clear the login-pending state after processing a callback.
    pub fn clear_login_pending(&self) {
        let mut s = self.state.lock().unwrap();
        s.login_pending = false;
        s.pending_state = None;
    }

    /// Returns true if a login flow is currently in progress.
    pub fn is_login_pending(&self) -> bool {
        self.state.lock().unwrap().login_pending
    }

    /// Get current auth state (in-memory cache, loaded from Keychain on startup).
    pub fn get_status(&self) -> AuthState {
        self.state.lock().unwrap().clone()
    }

    // -- Internal helpers --

    /// Generate a cryptographically secure state parameter for OAuth CSRF protection.
    fn generate_state() -> String {
        use rand::RngCore;
        use std::fmt::Write as _;

        let mut bytes = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);

        let mut state = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            let _ = write!(&mut state, "{:02x}", byte);
        }
        state
    }

    // -- Keychain helpers --

    fn keychain_get(key: &str) -> Option<String> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, key) {
            Ok(entry) => match entry.get_password() {
                Ok(val) if !val.is_empty() => Some(val),
                _ => None,
            },
            Err(_) => None,
        }
    }

    fn keychain_set(key: &str, value: &str) -> Result<(), AuthError> {
        let entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|e| AuthError::Keychain {
                key: key.to_string(),
                detail: e.to_string(),
            })?;
        entry.set_password(value).map_err(|e| AuthError::Keychain {
            key: key.to_string(),
            detail: e.to_string(),
        })
    }

    fn keychain_delete(key: &str) {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, key) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AuthManager;

    #[test]
    fn start_login_sets_pending_state() {
        let auth = AuthManager::new();

        let state = auth.start_login();
        let status = auth.get_status();

        assert!(status.login_pending);
        assert_eq!(status.pending_state.as_deref(), Some(state.as_str()));
    }

    #[test]
    fn verify_callback_requires_matching_state() {
        let auth = AuthManager::new();

        assert!(!auth.verify_callback(Some("irrelevant")));

        let state = auth.start_login();
        assert!(!auth.verify_callback(None));
        assert!(!auth.verify_callback(Some("wrong-state")));
        assert!(auth.verify_callback(Some(&state)));
    }

    #[test]
    fn clear_login_pending_resets_state() {
        let auth = AuthManager::new();

        auth.start_login();
        assert!(auth.is_login_pending());

        auth.clear_login_pending();
        let status = auth.get_status();

        assert!(!status.login_pending);
        assert!(status.pending_state.is_none());
    }

    #[test]
    fn generated_state_looks_random_and_hex_encoded() {
        let first = AuthManager::generate_state();
        let second = AuthManager::generate_state();

        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
