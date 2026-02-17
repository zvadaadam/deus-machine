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

/// Parse a git clone progress line (from stderr with --progress).
/// Matches patterns like "Receiving objects:  42% (52/123), 1.23 MiB"
/// and "Resolving deltas: 100% (89/89), done."
fn parse_git_progress(line: &str) -> Option<(String, String, usize)> {
    // Find percent: look for "NN%" pattern
    let pct_pos = line.find('%')?;
    let before_pct = &line[..pct_pos];
    let pct_start = before_pct.rfind(|c: char| !c.is_ascii_digit())?;
    let percent: usize = before_pct[pct_start + 1..].parse().ok()?;

    let (phase, status) = if line.contains("Receiving") {
        ("receiving", "Downloading...")
    } else if line.contains("Resolving") {
        ("resolving", "Almost done...")
    } else if line.contains("Compressing") || line.contains("Counting") || line.contains("Enumerating") {
        ("connecting", "Connecting...")
    } else {
        ("indexing", "Processing...")
    };

    Some((phase.to_string(), status.to_string(), percent))
}

/// Clone a git repository to a target directory with progress events.
/// Shells out to `git clone --progress` so SSH/HTTPS auth is handled natively
/// by the user's ssh-agent, ~/.ssh/config, credential helpers, and macOS Keychain.
#[tauri::command]
pub async fn git_clone(
    url: String,
    target_path: String,
    app_handle: tauri::AppHandle,
) -> Result<GitCloneResult, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

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

    let url_clone = url.clone();
    let target_clone = target.clone();
    let folder_name_clone = folder_name.clone();
    let app_clone = app_handle.clone();

    // Shell out to git CLI — handles SSH/HTTPS auth natively via
    // ssh-agent, ~/.ssh/config, credential helpers, macOS Keychain, etc.
    // No hand-rolled credential callback needed.
    let result = tokio::task::spawn_blocking(move || {
        let mut child = Command::new("git")
            .args(["clone", "--progress", &url_clone])
            .arg(&target_clone)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            // Disable interactive prompts — fail fast instead of hanging on TTY input
            .env("GIT_TERMINAL_PROMPT", "0")
            .spawn()
            .map_err(|e| format!("Failed to start git: {}", e))?;

        // Read stderr for progress lines and error output.
        // git --progress uses \r for in-place updates, so we split on both \r and \n.
        let mut last_percent: usize = 0;
        let mut stderr_capture = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let mut buf = [0u8; 512];
            let mut line_buf = String::new();
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]);
                        for ch in chunk.chars() {
                            if ch == '\r' || ch == '\n' {
                                if !line_buf.is_empty() {
                                    if let Some((phase, status, percent)) = parse_git_progress(&line_buf) {
                                        if percent != last_percent {
                                            last_percent = percent;
                                            let _ = app_clone.emit(
                                                "git-clone-progress",
                                                GitCloneProgress {
                                                    percent,
                                                    received: 0,
                                                    total: 0,
                                                    received_bytes: 0,
                                                    status,
                                                    phase,
                                                },
                                            );
                                        }
                                    }
                                    // Keep last ~500 chars for error reporting on failure
                                    stderr_capture.push_str(&line_buf);
                                    stderr_capture.push('\n');
                                    if stderr_capture.len() > 2000 {
                                        let drain = stderr_capture.len() - 1000;
                                        stderr_capture.drain(..drain);
                                    }
                                    line_buf.clear();
                                }
                            } else {
                                line_buf.push(ch);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }

        let status = child.wait().map_err(|e| format!("git clone failed: {}", e))?;
        if !status.success() {
            // Map common git error messages to user-friendly strings
            let msg = stderr_capture.trim().to_string();
            if msg.contains("Could not resolve host") || msg.contains("failed to resolve") {
                return Err("Could not connect. Check your internet connection.".to_string());
            } else if msg.contains("not found") || msg.contains("does not appear to be a git repository") {
                return Err("Repository not found. Check the URL and try again.".to_string());
            } else if msg.contains("Authentication failed") || msg.contains("Permission denied") || msg.contains("could not read") {
                return Err("Authentication failed. Check your SSH keys or credentials.".to_string());
            } else if msg.contains("SSL") || msg.contains("certificate") {
                return Err("SSL/certificate error. Check your network settings.".to_string());
            } else if msg.contains("already exists") {
                return Err(format!("Folder \"{}\" already exists", folder_name_clone));
            }
            // Last resort: show the raw message (last meaningful line)
            let last_line = msg.lines().rev().find(|l| !l.is_empty()).unwrap_or(&msg);
            return Err(format!("Clone failed: {}", last_line));
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Clone task failed: {}", e))?;

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
pub struct ChangedFilesResponse {
    pub files: Vec<DiffFileResponse>,
    /// True if the list was truncated (too many files)
    pub truncated: bool,
    /// Total number of changed files (before truncation)
    pub total_count: usize,
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
) -> Result<ChangedFilesResponse, String> {
    let start = Instant::now();
    let resolved = git::resolve_parent_branch(&workspace_path, Some(&parent_branch), Some(&default_branch));
    let result = git::get_changed_files(&workspace_path, &resolved)?;
    let elapsed = start.elapsed();
    if elapsed.as_millis() > 100 || result.truncated {
        println!("[GIT] git_diff_files took {}ms ({}, {}/{} files{})",
            elapsed.as_millis(), workspace_path,
            result.files.len(), result.total_count,
            if result.truncated { " TRUNCATED" } else { "" });
    }
    Ok(ChangedFilesResponse {
        files: result.files.into_iter().map(|f| DiffFileResponse {
            file: f.file, additions: f.additions, deletions: f.deletions
        }).collect(),
        truncated: result.truncated,
        total_count: result.total_count,
    })
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
pub fn git_uncommitted_files(
    workspace_path: String,
) -> Result<Vec<DiffFileResponse>, String> {
    let files = git::get_uncommitted_files(&workspace_path)?;
    Ok(files
        .into_iter()
        .map(|f| DiffFileResponse {
            file: f.file,
            additions: f.additions,
            deletions: f.deletions,
        })
        .collect())
}

#[tauri::command]
pub fn git_last_turn_files(
    workspace_path: String,
    session_id: String,
) -> Result<Vec<DiffFileResponse>, String> {
    let files = git::get_last_turn_files(&workspace_path, &session_id)?;
    Ok(files
        .into_iter()
        .map(|f| DiffFileResponse {
            file: f.file,
            additions: f.additions,
            deletions: f.deletions,
        })
        .collect())
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

    // -----------------------------------------------------------------------
    // parse_git_progress tests
    // -----------------------------------------------------------------------

    #[test]
    fn parse_progress_receiving_objects() {
        let (phase, _, pct) = parse_git_progress("Receiving objects:  42% (52/123), 1.23 MiB | 2.34 MiB/s").unwrap();
        assert_eq!(phase, "receiving");
        assert_eq!(pct, 42);
    }

    #[test]
    fn parse_progress_resolving_deltas() {
        let (phase, _, pct) = parse_git_progress("Resolving deltas: 100% (89/89), done.").unwrap();
        assert_eq!(phase, "resolving");
        assert_eq!(pct, 100);
    }

    #[test]
    fn parse_progress_remote_counting() {
        let (phase, _, pct) = parse_git_progress("remote: Counting objects:  50% (62/123)").unwrap();
        assert_eq!(phase, "connecting");
        assert_eq!(pct, 50);
    }

    #[test]
    fn parse_progress_no_percent() {
        assert!(parse_git_progress("Cloning into 'repo'...").is_none());
    }
}
