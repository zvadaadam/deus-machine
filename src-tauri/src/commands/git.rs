use std::path::{Component, Path, PathBuf};
use std::time::Instant;
use tauri::Emitter;
use crate::git;

#[derive(serde::Serialize, Clone)]
pub struct GitCloneProgress {
    pub percent: usize,
    pub received: usize,
    pub total: usize,
    pub received_bytes: usize,
    pub status: String,
    pub phase: String,
}

#[derive(serde::Serialize)]
pub struct GitCloneResult {
    pub path: String,
    pub name: String,
}

fn resolve_home_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let home_drive = std::env::var_os("HOMEDRIVE")?;
                let home_path = std::env::var_os("HOMEPATH")?;
                Some(PathBuf::from(format!("{}{}", home_drive.to_string_lossy(), home_path.to_string_lossy())))
            })
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn validate_git_clone_target(target: &Path) -> Result<PathBuf, String> {
    if target.as_os_str().is_empty() {
        return Err("Target path is required".to_string());
    }

    if !target.is_absolute() {
        return Err("Target path must be absolute".to_string());
    }

    if target
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Target path must not contain '..' segments".to_string());
    }

    let home_dir = resolve_home_dir().ok_or_else(|| "Unable to resolve home directory".to_string())?;
    let canonical_home = std::fs::canonicalize(&home_dir).unwrap_or(home_dir);

    let parent = target
        .parent()
        .ok_or_else(|| "Target path must include a parent directory".to_string())?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Invalid target path: {}", e))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Target path must include a directory name".to_string())?;
    let canonical_target = canonical_parent.join(file_name);

    if !canonical_target.starts_with(&canonical_home) {
        return Err("Target path must be within your home directory".to_string());
    }

    Ok(canonical_target)
}

fn validate_git_clone_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Repository URL is required".to_string());
    }

    if url.starts_with("file://") || url.starts_with('/') || url.starts_with('\\') {
        return Err("Only https:// or ssh URLs are allowed for cloning".to_string());
    }

    if url.starts_with("https://") || url.starts_with("ssh://") || url.starts_with("git@") {
        return Ok(());
    }

    Err("Only https:// or ssh URLs are allowed for cloning".to_string())
}

/// Validate that file_path resolves to a location within workspace_path.
/// Prevents path traversal attacks (e.g. "../../etc/passwd") by canonicalizing
/// the joined path and verifying it remains under the workspace root.
/// Returns the validated absolute path, or an error if traversal is detected.
fn validate_workspace_path(workspace_path: &str, file_path: &str) -> Result<PathBuf, String> {
    let workspace = Path::new(workspace_path);
    let joined = workspace.join(file_path);

    // Canonicalize to resolve all ".." segments and symlinks.
    // If the path doesn't exist (new, untracked, or deleted files where the
    // parent directory may also be gone), walk up to the nearest existing
    // ancestor, canonicalize that, then re-append the missing components.
    let canonical = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {}", e))?
    } else {
        let mut ancestor = joined.as_path();
        let mut suffix = PathBuf::new();
        while !ancestor.exists() {
            let name = ancestor
                .file_name()
                .ok_or_else(|| "Invalid file path".to_string())?;
            suffix = PathBuf::from(name).join(&suffix);
            ancestor = ancestor
                .parent()
                .ok_or_else(|| "Invalid file path".to_string())?;
        }
        let canonical_ancestor = ancestor
            .canonicalize()
            .map_err(|e| format!("Failed to resolve parent path: {}", e))?;
        canonical_ancestor.join(suffix)
    };

    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;

    if !canonical.starts_with(&canonical_workspace) {
        return Err(format!(
            "Path traversal detected: '{}' escapes workspace",
            file_path
        ));
    }

    Ok(canonical)
}

/// Clone a git repository to a target directory with progress events.
/// Runs on a background thread to avoid blocking the UI.
#[tauri::command]
pub async fn git_clone(
    url: String,
    target_path: String,
    app_handle: tauri::AppHandle,
) -> Result<GitCloneResult, String> {
    use git2::{build::RepoBuilder, Cred, CredentialType, ErrorCode, FetchOptions, RemoteCallbacks};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    validate_git_clone_url(&url)?;

    // Syntactic validation first — no filesystem side effects before these checks.
    // Rejects empty, relative, and `..`-containing paths before we create any directories.
    let target_raw = Path::new(&target_path);
    if target_raw.as_os_str().is_empty() {
        return Err("Target path is required".to_string());
    }
    if !target_raw.is_absolute() {
        return Err("Target path must be absolute".to_string());
    }
    if target_raw
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Target path must not contain '..' segments".to_string());
    }

    // Ensure parent directories exist (e.g. ~/Projects) before canonicalization
    let target_parent = target_raw
        .parent()
        .ok_or_else(|| "Target path must include a parent directory".to_string())?;
    if !target_parent.exists() {
        std::fs::create_dir_all(target_parent)
            .map_err(|e| format!("Could not create directory \"{}\": {}", target_parent.display(), e))?;
    }

    // Full validation including canonicalization + home directory containment
    let target = validate_git_clone_target(target_raw)?;
    let folder_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repository")
        .to_string();

    // Pre-clone validation (fast, can stay on async thread)
    if target.exists() {
        if target.is_dir() {
            let is_non_empty = std::fs::read_dir(&target)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);

            if is_non_empty {
                let git_dir = target.join(".git");
                if git_dir.exists() {
                    return Err(format!(
                        "\"{}\" already contains a git repository. Use \"Add Repository\" instead.",
                        folder_name
                    ));
                }
                return Err(format!(
                    "Folder \"{}\" already exists and is not empty",
                    folder_name
                ));
            }
        } else {
            return Err(format!("A file named \"{}\" already exists at this location", folder_name));
        }
    }

    let _ = app_handle.emit(
        "git-clone-progress",
        GitCloneProgress {
            percent: 0,
            received: 0,
            total: 0,
            received_bytes: 0,
            status: "Connecting...".to_string(),
            phase: "connecting".to_string(),
        },
    );

    // Clone values for the blocking task
    let url_clone = url.clone();
    let target_clone = target.clone();
    let folder_name_clone = folder_name.clone();
    let app_clone = app_handle.clone();

    // Run blocking git2 operations on a separate thread
    let result = tokio::task::spawn_blocking(move || {
        let last_percent = Arc::new(AtomicUsize::new(0));
        let app = app_clone.clone();
        let mut callbacks = RemoteCallbacks::new();
        let progress_tracker = last_percent.clone();

        // Credential callback: cycles through credential sources on each retry.
        // libgit2 calls this again when auth fails — we MUST return a different
        // credential each time, or return Err to stop the loop.
        //
        // SSH strategy (one source per attempt):
        //   0: SSH agent (tries all agent identities internally)
        //   1: ~/.ssh/id_ed25519
        //   2: ~/.ssh/id_rsa
        //   3: ~/.ssh/id_ecdsa
        //   4+: give up
        //
        // HTTPS strategy: credential helper once, then give up (no TTY).
        let auth_attempts = Arc::new(AtomicUsize::new(0));
        callbacks.credentials(move |_url, username_from_url, allowed_types| {
            let attempt = auth_attempts.fetch_add(1, Ordering::Relaxed);
            let username = username_from_url.unwrap_or("git");

            if allowed_types.contains(CredentialType::SSH_KEY) {
                let home = std::env::var("HOME").unwrap_or_default();
                let ssh_dir = PathBuf::from(&home).join(".ssh");
                let key_names = ["id_ed25519", "id_rsa", "id_ecdsa"];

                match attempt {
                    // Attempt 0: SSH agent (iterates all agent identities internally)
                    0 => Cred::ssh_key_from_agent(username).map_err(|_| {
                        git2::Error::from_str("SSH agent not available")
                    }),
                    // Attempts 1-3: try specific key files in priority order
                    n @ 1..=3 => {
                        let key_name = key_names[n - 1];
                        let private_key = ssh_dir.join(key_name);
                        if !private_key.exists() {
                            return Err(git2::Error::from_str(&format!(
                                "~/.ssh/{} not found",
                                key_name
                            )));
                        }
                        let public_key = ssh_dir.join(format!("{}.pub", key_name));
                        let pub_path = if public_key.exists() {
                            Some(public_key.as_path())
                        } else {
                            None
                        };
                        Cred::ssh_key(username, pub_path, &private_key, None)
                    }
                    _ => Err(git2::Error::from_str(
                        "Authentication failed: no valid SSH key found. \
                         Add your SSH key to ssh-agent or use HTTPS.",
                    )),
                }
            } else if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) {
                if attempt > 0 {
                    return Err(git2::Error::from_str(
                        "Authentication failed. Check your git credentials.",
                    ));
                }
                let config = git2::Config::open_default()
                    .map_err(|_| git2::Error::from_str("Could not open git config"))?;
                Cred::credential_helper(&config, _url, username_from_url)
            } else if allowed_types.contains(CredentialType::DEFAULT) {
                if attempt > 0 {
                    return Err(git2::Error::from_str("Default credentials not accepted"));
                }
                Cred::default()
            } else {
                Err(git2::Error::from_str("Unsupported authentication method"))
            }
        });

        callbacks.transfer_progress(move |stats| {
            let total = stats.total_objects();
            let received = stats.received_objects();
            let indexed = stats.indexed_objects();
            let received_bytes = stats.received_bytes();
            let percent = if total > 0 {
                (received * 100) / total
            } else {
                0
            };

            // Composite tracker: encode both receive percent and indexed percent
            // so events keep flowing during the indexing phase (where percent stays 100).
            let indexed_pct = if total > 0 { (indexed * 100) / total } else { 0 };
            let composite = percent * 1000 + indexed_pct;

            let last = progress_tracker.load(Ordering::Relaxed);
            if composite != last {
                progress_tracker.store(composite, Ordering::Relaxed);

                let (phase, status) = if received < total {
                    ("receiving".to_string(), "Downloading...".to_string())
                } else if indexed < total {
                    ("indexing".to_string(), "Processing...".to_string())
                } else {
                    ("resolving".to_string(), "Almost done...".to_string())
                };

                // During indexing, received==total so percent is stuck at 100.
                // Show indexing progress instead so the frontend bar advances.
                let display_percent = if received >= total && indexed < total {
                    indexed_pct
                } else {
                    percent
                };

                let _ = app.emit(
                    "git-clone-progress",
                    GitCloneProgress {
                        percent: display_percent,
                        received,
                        total,
                        received_bytes,
                        status,
                        phase,
                    },
                );
            }
            true
        });

        let mut fetch_options = FetchOptions::new();
        fetch_options.remote_callbacks(callbacks);

        let mut builder = RepoBuilder::new();
        builder.fetch_options(fetch_options);

        builder.clone(&url_clone, &target_clone).map_err(|e| {
            match e.code() {
                ErrorCode::NotFound => "Repository not found. Check the URL and try again.".to_string(),
                ErrorCode::Auth => "Authentication failed. Check your SSH keys or credentials.".to_string(),
                ErrorCode::Exists => format!("Folder \"{}\" already exists", folder_name_clone),
                _ => {
                    let msg = e.message();
                    if msg.contains("failed to resolve address") || msg.contains("Could not resolve host") {
                        "Could not connect. Check your internet connection.".to_string()
                    } else if msg.contains("SSL") || msg.contains("certificate") {
                        "SSL/certificate error. Check your network settings.".to_string()
                    } else if msg.contains("Authentication failed") || msg.contains("authentication") {
                        "Authentication failed. Check your SSH keys or credentials.".to_string()
                    } else {
                        format!("Clone failed: {}", msg)
                    }
                }
            }
        })
    })
    .await
    .map_err(|e| format!("Clone task failed: {}", e))?;

    // Handle the inner Result from the blocking task
    result?;

    let _ = app_handle.emit(
        "git-clone-progress",
        GitCloneProgress {
            percent: 100,
            received: 0,
            total: 0,
            received_bytes: 0,
            status: "Complete".to_string(),
            phase: "complete".to_string(),
        },
    );

    Ok(GitCloneResult {
        path: target_path,
        name: folder_name,
    })
}

// ============================================================================
// NEW GIT COMMANDS (delegate to crate::git module)
// ============================================================================

/// Response types for git diff operations
#[derive(serde::Serialize)]
pub struct DiffStatsResponse {
    pub additions: u32,
    pub deletions: u32,
}

#[derive(serde::Serialize)]
pub struct DiffFileResponse {
    pub file: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(serde::Serialize)]
pub struct FileDiffResponse {
    pub file: String,
    pub diff: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
}

#[tauri::command]
pub fn git_diff_stats(
    workspace_path: String,
    parent_branch: String,
    default_branch: String,
) -> Result<DiffStatsResponse, String> {
    let start = Instant::now();
    let resolved = git::resolve_parent_branch(&workspace_path, Some(&parent_branch), Some(&default_branch));
    let stats = git::get_diff_stats(&workspace_path, &resolved)?;
    let elapsed = start.elapsed();
    if elapsed.as_millis() > 100 {
        println!("[GIT] git_diff_stats took {}ms ({})", elapsed.as_millis(), workspace_path);
    }
    Ok(DiffStatsResponse { additions: stats.additions, deletions: stats.deletions })
}

#[tauri::command]
pub fn git_diff_files(
    workspace_path: String,
    parent_branch: String,
    default_branch: String,
) -> Result<Vec<DiffFileResponse>, String> {
    let start = Instant::now();
    let resolved = git::resolve_parent_branch(&workspace_path, Some(&parent_branch), Some(&default_branch));
    let files = git::get_changed_files(&workspace_path, &resolved)?;
    let elapsed = start.elapsed();
    if elapsed.as_millis() > 100 {
        println!("[GIT] git_diff_files took {}ms ({}, {} files)", elapsed.as_millis(), workspace_path, files.len());
    }
    Ok(files.into_iter().map(|f| DiffFileResponse { file: f.file, additions: f.additions, deletions: f.deletions }).collect())
}

#[tauri::command]
pub fn git_diff_file(
    workspace_path: String,
    parent_branch: String,
    default_branch: String,
    file_path: String,
) -> Result<FileDiffResponse, String> {
    let start = Instant::now();
    let resolved = git::resolve_parent_branch(&workspace_path, Some(&parent_branch), Some(&default_branch));
    let diff = git::get_file_patch(&workspace_path, &resolved, &file_path)?;
    let merge_base = git::get_merge_base(&workspace_path, &resolved)?;
    let old_content = git::get_git_file_content(&workspace_path, &merge_base, &file_path)?;

    // Read from working directory (not HEAD) since diffs compare merge-base against workdir.
    // Matches the Node.js fallback in backend/src/routes/workspaces.ts.
    // Validate that file_path doesn't escape the workspace (prevents path traversal).
    let workdir_path = validate_workspace_path(&workspace_path, &file_path)?;
    let new_content = match std::fs::read(&workdir_path) {
        Ok(bytes) => {
            // Detect binary files (null bytes in first 8KB)
            let sample_len = bytes.len().min(8192);
            if bytes[..sample_len].iter().any(|&b| b == 0) {
                None
            } else {
                String::from_utf8(bytes).ok()
            }
        }
        Err(_) => git::get_git_file_content(&workspace_path, "HEAD", &file_path)?,
    };
    let elapsed = start.elapsed();
    if elapsed.as_millis() > 200 {
        println!("[GIT] git_diff_file took {}ms ({}: {})", elapsed.as_millis(), workspace_path, file_path);
    }
    Ok(FileDiffResponse { file: file_path, diff, old_content, new_content })
}

#[tauri::command]
pub fn git_detect_default_branch(root_path: String) -> Result<String, String> {
    Ok(git::detect_default_branch(&root_path))
}

#[tauri::command]
pub fn git_list_branches(workspace_path: String) -> Result<Vec<git::BranchInfo>, String> {
    git::list_branches(&workspace_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // -----------------------------------------------------------------------
    // validate_git_clone_url tests
    // -----------------------------------------------------------------------

    #[test]
    fn clone_url_accepts_https() {
        assert!(validate_git_clone_url("https://github.com/user/repo.git").is_ok());
    }

    #[test]
    fn clone_url_accepts_ssh() {
        assert!(validate_git_clone_url("ssh://git@github.com/user/repo.git").is_ok());
    }

    #[test]
    fn clone_url_accepts_git_at() {
        assert!(validate_git_clone_url("git@github.com:user/repo.git").is_ok());
    }

    #[test]
    fn clone_url_rejects_empty() {
        assert!(validate_git_clone_url("").is_err());
    }

    #[test]
    fn clone_url_rejects_file_protocol() {
        assert!(validate_git_clone_url("file:///tmp/repo").is_err());
    }

    #[test]
    fn clone_url_rejects_absolute_path() {
        assert!(validate_git_clone_url("/tmp/repo").is_err());
    }

    #[test]
    fn clone_url_rejects_http_typo() {
        assert!(validate_git_clone_url("ftp://github.com/repo").is_err());
    }

    // -----------------------------------------------------------------------
    // validate_git_clone_target tests
    // -----------------------------------------------------------------------

    #[test]
    fn clone_target_rejects_empty_path() {
        let result = validate_git_clone_target(std::path::Path::new(""));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("required"));
    }

    #[test]
    fn clone_target_rejects_relative_path() {
        let result = validate_git_clone_target(std::path::Path::new("relative/path"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute"));
    }

    #[test]
    fn clone_target_rejects_parent_dir_traversal() {
        let result = validate_git_clone_target(std::path::Path::new("/home/user/../etc/repo"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(".."));
    }

    #[test]
    fn clone_target_accepts_valid_path_in_home() {
        // Create a real directory inside home so the parent exists
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let target = PathBuf::from(&home).join("test-clone-target-xyz");
        // Ensure parent is valid (it's $HOME which exists)
        let result = validate_git_clone_target(&target);
        assert!(result.is_ok(), "Should accept path in home dir: {:?}", result);
    }

    #[test]
    fn clone_target_rejects_outside_home() {
        // /tmp is typically outside $HOME
        let dir = TempDir::new_in("/tmp").unwrap();
        let target = dir.path().join("subdir");
        fs::create_dir_all(dir.path()).unwrap();
        let result = validate_git_clone_target(&target);
        // This should fail because /tmp is not under $HOME
        // (unless $HOME is /tmp, which is unlikely)
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.starts_with("/tmp") {
            assert!(result.is_err(), "Should reject path outside home dir");
        }
    }

    // -----------------------------------------------------------------------
    // Response type serialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn diff_stats_response_serializes() {
        let resp = DiffStatsResponse { additions: 42, deletions: 7 };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"additions\":42"));
        assert!(json.contains("\"deletions\":7"));
    }

    #[test]
    fn diff_file_response_serializes() {
        let resp = DiffFileResponse {
            file: "test.rs".to_string(),
            additions: 10,
            deletions: 3,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"file\":\"test.rs\""));
    }

    #[test]
    fn file_diff_response_serializes_with_none_content() {
        let resp = FileDiffResponse {
            file: "new.rs".to_string(),
            diff: "+added line".to_string(),
            old_content: None,
            new_content: Some("added line".to_string()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"old_content\":null"));
        assert!(json.contains("\"new_content\":\"added line\""));
    }
}
