/**
 * Cookie sync commands — read and decrypt cookies from installed browsers.
 *
 * Reads Chrome/Arc/Brave/Edge cookie SQLite databases, decrypts values
 * using macOS Keychain, and returns them for injection into browser webviews.
 *
 * Decryption flow (Chromium on macOS):
 * 1. Get encryption key from macOS Keychain (via `security find-generic-password`)
 * 2. Derive AES key: PBKDF2(password=keychain_key, salt="saltysalt", iterations=1003, keyLen=16, SHA1)
 * 3. For each cookie with encrypted_value starting with "v10":
 *    - Strip 3-byte prefix ("v10")
 *    - AES-128-CBC decrypt (IV = 16 spaces)
 *    - Remove PKCS7 padding
 */

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use serde::Serialize;
use std::path::PathBuf;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// Browser definitions: (name, keychain_service, cookie_db_path_suffix).
/// Path suffix is relative to $HOME.
const BROWSER_DEFINITIONS: &[(&str, &str, &str)] = &[
    ("Chrome", "Chrome Safe Storage", "Library/Application Support/Google/Chrome/Default/Cookies"),
    ("Arc", "Arc Safe Storage", "Library/Application Support/Arc/User Data/Default/Cookies"),
    ("Brave", "Brave Safe Storage", "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies"),
    ("Edge", "Microsoft Edge Safe Storage", "Library/Application Support/Microsoft Edge/Default/Cookies"),
];

/// A browser that can provide cookies
#[derive(Debug, Serialize, Clone)]
pub struct InstalledBrowser {
    pub name: String,
    pub keychain_service: String,
    pub cookie_db_path: String,
    pub available: bool,
}

/// A decrypted cookie ready for injection
#[derive(Debug, Serialize)]
pub struct DecryptedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: String,
    pub expires: i64,
}

/// Detect which browsers are installed and available for cookie sync.
#[tauri::command]
pub async fn get_cookie_browsers() -> Result<Vec<InstalledBrowser>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let mut result = Vec::new();
    for (name, keychain_service, path_suffix) in BROWSER_DEFINITIONS {
        let cookie_db_path = format!("{}/{}", home, path_suffix);
        let available = PathBuf::from(&cookie_db_path).exists();
        result.push(InstalledBrowser {
            name: name.to_string(),
            keychain_service: keychain_service.to_string(),
            cookie_db_path,
            available,
        });
    }
    Ok(result)
}

/// Sync cookies from a browser for a specific domain.
///
/// Reads the browser's cookie SQLite DB, decrypts cookie values using the
/// macOS Keychain encryption key, and returns cookies matching the given domain.
/// Only returns cookies that can be injected (non-HttpOnly cookies via
/// document.cookie, HttpOnly cookies need native WKHTTPCookieStore).
#[tauri::command]
pub async fn sync_browser_cookies(
    browser_name: String,
    domain: String,
) -> Result<Vec<DecryptedCookie>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;

    // Find the browser config from shared definitions
    let (keychain_service, cookie_db_path) = BROWSER_DEFINITIONS
        .iter()
        .find(|(name, _, _)| *name == browser_name.as_str())
        .map(|(_, ks, suffix)| (*ks, format!("{}/{}", home, suffix)))
        .ok_or_else(|| format!("Unknown browser: {}", browser_name))?;

    // Step 1: Get encryption key from macOS Keychain
    let keychain_password = get_keychain_password(keychain_service)?;

    // Step 2: Derive AES key via PBKDF2
    let aes_key = derive_aes_key(&keychain_password)?;

    // Step 3: Read and decrypt cookies from SQLite
    // Copy the DB first to avoid locking issues with the running browser
    let temp_dir = std::env::temp_dir();
    let temp_db = temp_dir.join(format!("opendevs-cookies-{}.db", browser_name.to_lowercase()));
    std::fs::copy(&cookie_db_path, &temp_db).map_err(|e| {
        format!(
            "Failed to copy cookie DB (is {} running?): {}",
            browser_name, e
        )
    })?;

    let cookies = read_and_decrypt_cookies(&temp_db, &domain, &aes_key)?;

    // Clean up temp file
    std::fs::remove_file(&temp_db).ok();

    Ok(cookies)
}

/// Get the encryption password from macOS Keychain using `security` CLI.
fn get_keychain_password(service: &str) -> Result<String, String> {
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-w", "-s", service])
        .output()
        .map_err(|e| format!("Failed to run security command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Keychain access denied for '{}'. You may need to grant access in Keychain Access. Error: {}",
            service, stderr.trim()
        ));
    }

    let password = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if password.is_empty() {
        return Err(format!("Empty password returned from Keychain for '{}'", service));
    }

    Ok(password)
}

/// Derive the AES-128-CBC key from the Keychain password using PBKDF2.
/// Chrome uses: salt="saltysalt", iterations=1003, keyLen=16, hash=SHA1
fn derive_aes_key(password: &str) -> Result<[u8; 16], String> {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
    Ok(key)
}

/// Read cookies from the SQLite DB and decrypt their values.
///
/// Uses LIKE matching (same as Ami) for broad domain coverage — catches
/// subdomains and dot-prefixed entries. Reads both `value` (plain text)
/// and `encrypted_value` columns: plain text wins if non-empty.
fn read_and_decrypt_cookies(
    db_path: &PathBuf,
    domain: &str,
    aes_key: &[u8; 16],
) -> Result<Vec<DecryptedCookie>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("Failed to open cookie DB: {}", e))?;

    // Use proper domain boundary matching to prevent substring attacks.
    // Chromium stores host_key as either "example.com" or ".example.com" (dot-prefixed).
    // We match:
    //   1. Exact match: example.com
    //   2. Dot-prefixed: .example.com (subdomain-inclusive cookies)
    //   3. Subdomain pattern: %.example.com (matches sub.example.com, .sub.example.com)
    let clean_domain = domain.trim_start_matches('.');
    let dot_domain = format!(".{}", clean_domain);
    let subdomain_pattern = format!("%.{}", clean_domain);

    let mut stmt = conn
        .prepare(
            "SELECT name, value, encrypted_value, host_key, path, is_secure, is_httponly, \
             samesite, expires_utc \
             FROM cookies \
             WHERE host_key = ?1 OR host_key = ?2 OR host_key LIKE ?3 \
             ORDER BY name",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map(rusqlite::params![clean_domain, dot_domain, subdomain_pattern], |row| {
            let name: String = row.get(0)?;
            let plain_value: String = row.get(1)?;
            let encrypted_value: Vec<u8> = row.get(2)?;
            let host_key: String = row.get(3)?;
            let path: String = row.get(4)?;
            let is_secure: bool = row.get(5)?;
            let is_httponly: bool = row.get(6)?;
            let samesite: i32 = row.get(7)?;
            let expires_utc: i64 = row.get(8)?;

            Ok((
                name,
                plain_value,
                encrypted_value,
                host_key,
                path,
                is_secure,
                is_httponly,
                samesite,
                expires_utc,
            ))
        })
        .map_err(|e| format!("Failed to query cookies: {}", e))?;

    let mut cookies = Vec::new();
    for row in rows {
        let (name, plain_value, encrypted_value, host_key, path, is_secure, is_httponly, samesite, expires_utc) =
            row.map_err(|e| format!("Failed to read row: {}", e))?;

        // Prefer plain value column (Chrome stores some cookies unencrypted).
        // Fall back to decrypting encrypted_value if plain is empty.
        let value = if !plain_value.is_empty() {
            plain_value
        } else {
            match decrypt_cookie_value(&encrypted_value, aes_key) {
                Ok(v) => v,
                Err(_) => continue, // Skip cookies we can't decrypt
            }
        };

        // Skip empty values
        if value.is_empty() {
            continue;
        }

        let same_site_str = match samesite {
            0 => "none",
            1 => "lax",
            2 => "strict",
            _ => "lax",
        }
        .to_string();

        cookies.push(DecryptedCookie {
            name,
            value,
            domain: host_key,
            path,
            secure: is_secure,
            http_only: is_httponly,
            same_site: same_site_str,
            expires: expires_utc,
        });
    }

    Ok(cookies)
}

/// Decrypt a single Chromium cookie value.
/// Format: "v10" prefix (3 bytes) + AES-128-CBC encrypted data
/// IV = 16 spaces (0x20)
fn decrypt_cookie_value(encrypted: &[u8], aes_key: &[u8; 16]) -> Result<String, String> {
    // Unencrypted cookie (no prefix)
    if encrypted.is_empty() {
        return Ok(String::new());
    }

    // Check for "v10" prefix (Chromium macOS encryption marker)
    if encrypted.len() < 3 || &encrypted[0..3] != b"v10" {
        // Try as plain text
        return Ok(String::from_utf8_lossy(encrypted).to_string());
    }

    let ciphertext = &encrypted[3..];
    if ciphertext.is_empty() {
        return Ok(String::new());
    }

    // IV = 16 spaces (0x20)
    let iv: [u8; 16] = [0x20; 16];

    // Decrypt AES-128-CBC with PKCS7 padding
    let mut buf = ciphertext.to_vec();
    let decrypted = Aes128CbcDec::new(aes_key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("AES decryption failed: {}", e))?;

    String::from_utf8(decrypted.to_vec())
        .map_err(|e| format!("Cookie value is not valid UTF-8: {}", e))
}
