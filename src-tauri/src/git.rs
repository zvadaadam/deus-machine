// Git Operations Module
//
// Pure git2-based operations for diff computation, branch resolution,
// and file content retrieval. These are stateless functions that open
// the repository on each call (fast -- libgit2 caches internally).
//
// DIFF SEMANTICS:
// All diffs compare the merge-base to the WORKING DIRECTORY (not HEAD).
// This captures committed + staged + unstaged + untracked changes -- important
// because AI agents often leave uncommitted working tree changes.
//
// Steps:
//   1. resolve_parent_branch()    -> finds upstream ref (prefers origin/*, never local-first)
//   2. compute_merge_base_sha()   -> finds fork point via git CLI (merge-base of HEAD and upstream)
//   3. git diff <merge-base>      -> all tracked changes since fork
//   4. git ls-files --others      -> untracked files (new files created by agents)
//
// IMPLEMENTATION NOTE: We use git CLI (not libgit2) for the diff pipeline
// because libgit2's diff_tree_to_workdir_with_index has issues with git
// worktrees, causing phantom diffs (thousands of false deletions). Both
// Conductor and Codex (competitor IDEs) use git CLI for the same reason.
// libgit2 is still used for non-diff operations (branch listing, file content).
//
// PUBLIC API (called from commands/git.rs):
//   - get_diff_stats()         -> aggregate { additions, deletions } counts
//   - get_changed_files()         -> per-file list: [{ file, additions, deletions }]
//   - get_file_patch()          -> unified diff patch for a single file
//   - get_git_file_content()   -> file content at a specific ref
//   - get_merge_base()         -> merge-base commit SHA
//
// CACHING:
// Branch resolution results are cached with a 5-second TTL to avoid
// repeated ref lookups during rapid UI interactions (e.g., polling).

use git2::{BranchType, DiffOptions, Repository};
use lazy_static::lazy_static;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct DiffStats {
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiffFile {
    pub file: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct ChangedFilesResult {
    pub files: Vec<DiffFile>,
    /// True if the list was truncated to MAX_CHANGED_FILES
    pub truncated: bool,
    /// Total number of changed files (before truncation)
    pub total_count: usize,
}

/// Safety cap on the number of changed files returned to the frontend.
/// Prevents UI freeze when merge-base is stale and thousands of files show as changed.
const MAX_CHANGED_FILES: usize = 1000;

#[derive(Serialize, Clone, Debug)]
pub struct FileDiffResult {
    pub file: String,
    pub diff: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
    pub is_head: bool,
}

// ---------------------------------------------------------------------------
// Branch resolution cache (5 s TTL)
// ---------------------------------------------------------------------------

struct CacheEntry {
    value: String,
    created: Instant,
}

lazy_static! {
    static ref BRANCH_CACHE: Mutex<HashMap<String, CacheEntry>> = Mutex::new(HashMap::new());
}

const CACHE_TTL_SECS: u64 = 5;

fn cache_get(key: &str) -> Option<String> {
    let cache = BRANCH_CACHE.lock();
    cache.get(key).and_then(|entry| {
        if entry.created.elapsed().as_secs() < CACHE_TTL_SECS {
            Some(entry.value.clone())
        } else {
            None
        }
    })
}

fn cache_set(key: String, value: String) {
    let mut cache = BRANCH_CACHE.lock();
    cache.insert(
        key,
        CacheEntry {
            value,
            created: Instant::now(),
        },
    );
}

// ---------------------------------------------------------------------------
// Git CLI helpers
//
// The merge-base + diff pipeline uses git CLI instead of libgit2 because
// libgit2's diff_tree_to_workdir_with_index has known issues with git
// worktrees (phantom diffs where thousands of files appear as deleted).
// Both Conductor and Codex (competitor IDEs) use git CLI for the same reason.
// ---------------------------------------------------------------------------

/// Default timeout for short git operations (rev-parse, ls-files, merge-base).
const GIT_TIMEOUT_SHORT_MS: u64 = 5_000;
/// Timeout for potentially large operations (diff --numstat on big repos).
const GIT_TIMEOUT_LONG_MS: u64 = 15_000;

/// Run a git CLI command with a timeout and return stdout as a trimmed string.
/// Uses spawn + polling instead of output() to enforce a deadline.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    run_git_with_timeout(cwd, args, GIT_TIMEOUT_SHORT_MS, true)
}

/// Run a git CLI command with a longer timeout (for diff operations).
fn run_git_long(cwd: &str, args: &[&str]) -> Result<String, String> {
    run_git_with_timeout(cwd, args, GIT_TIMEOUT_LONG_MS, true)
}

/// Run a git CLI command and return raw stdout (untrimmed, for diff patches).
fn run_git_raw(cwd: &str, args: &[&str]) -> Result<String, String> {
    run_git_with_timeout(cwd, args, GIT_TIMEOUT_LONG_MS, false)
}

/// Core git runner with configurable timeout and trimming.
/// Spawns the process and polls try_wait() to enforce a deadline,
/// matching the Node.js backend which uses execFileSync({ timeout }).
fn run_git_with_timeout(
    cwd: &str,
    args: &[&str],
    timeout_ms: u64,
    trim: bool,
) -> Result<String, String> {
    let mut child = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to run git {}: {}",
                args.first().unwrap_or(&""),
                e
            )
        })?;

    let deadline = Instant::now() + std::time::Duration::from_millis(timeout_ms);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Process exited — read output
                let output = child.wait_with_output().map_err(|e| {
                    format!("Failed to read git output: {}", e)
                })?;

                if !status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!(
                        "git {} failed: {}",
                        args.join(" "),
                        stderr.trim()
                    ));
                }

                let stdout = String::from_utf8_lossy(&output.stdout);
                return Ok(if trim {
                    stdout.trim().to_string()
                } else {
                    stdout.into_owned()
                });
            }
            Ok(None) => {
                // Still running — check deadline
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait(); // reap zombie
                    return Err(format!(
                        "git {} timed out after {}ms",
                        args.join(" "),
                        timeout_ms
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => {
                return Err(format!("Failed to poll git process: {}", e));
            }
        }
    }
}

/// Compute the merge-base SHA between HEAD and the parent branch via git CLI.
/// Handles worktrees correctly (unlike libgit2 in some edge cases).
/// Falls back to HEAD SHA if merge-base fails (shows only uncommitted changes).
fn compute_merge_base_sha(workspace_path: &str, parent_branch: &str) -> Result<String, String> {
    match run_git(workspace_path, &["merge-base", "HEAD", parent_branch]) {
        Ok(sha) if !sha.is_empty() => Ok(sha),
        Ok(_) | Err(_) => {
            // Fallback: use HEAD (diff will show uncommitted changes only)
            run_git(workspace_path, &["rev-parse", "HEAD"])
        }
    }
}

/// Maximum file size to read for line counting (10 MB).
/// Matches the Node.js backend's countFileLines cap.
const MAX_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;

/// Sample size for binary detection (first 8 KB).
const BINARY_SAMPLE_BYTES: usize = 8 * 1024;

/// Count lines in a file with safety guards:
/// - Skips files larger than MAX_FILE_SIZE_BYTES (counts as 1 line)
/// - Detects binary files via null-byte sampling (counts as 1 line)
/// - Counts newlines at byte level without loading the full file into a String
///
/// Mirrors the Node.js backend's countFileLines behavior.
fn count_file_lines(path: &std::path::Path) -> u32 {
    use std::io::Read;

    // Check file size — skip oversized files (e.g. lockfiles, generated code)
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return 1,
    };
    if metadata.len() > MAX_FILE_SIZE_BYTES {
        return 1;
    }
    if metadata.len() == 0 {
        return 0;
    }

    // Read the first 8 KB to detect binary content (null bytes)
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return 1,
    };
    let mut sample = vec![0u8; BINARY_SAMPLE_BYTES.min(metadata.len() as usize)];
    if file.read_exact(&mut sample).is_err() {
        return 1;
    }
    if sample.contains(&0) {
        // Binary file — count as 1 addition (matches Node.js behavior)
        return 1;
    }

    // Count newlines at byte level — already read sample, count there first
    let mut newlines = bytecount::count(&sample, b'\n') as u32;

    // Read and count remaining bytes in chunks
    let mut buf = vec![0u8; 64 * 1024]; // 64 KB chunks
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                newlines += bytecount::count(&buf[..n], b'\n') as u32;
            }
            Err(_) => break,
        }
    }

    // A file with content but no trailing newline still has at least 1 line
    if newlines == 0 && metadata.len() > 0 {
        1
    } else {
        newlines
    }
}

/// Count lines in untracked files and return them as DiffFile entries.
/// Supplements `git diff --numstat` which excludes untracked files.
fn collect_untracked_files(workspace_path: &str) -> Vec<DiffFile> {
    let untracked = match run_git(
        workspace_path,
        &["ls-files", "--others", "--exclude-standard"],
    ) {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };

    untracked
        .lines()
        .filter(|f| !f.is_empty())
        .map(|file| {
            let file_path = std::path::Path::new(workspace_path).join(file);
            let line_count = count_file_lines(&file_path);
            DiffFile {
                file: file.to_string(),
                additions: if line_count == 0 { 1 } else { line_count },
                deletions: 0,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Helper: resolve a branch name to a git2::Tree
// ---------------------------------------------------------------------------

/// Resolve a branch string to its tree object.
///
/// Handles multiple formats:
///   - "origin/main"            -> refs/remotes/origin/main
///   - "refs/remotes/origin/…"  -> used as-is
///   - "refs/heads/…"           -> used as-is
///   - "main"                   -> tries refs/heads/main, then refs/remotes/origin/main
#[cfg(test)]
fn resolve_branch_tree<'a>(
    repo: &'a Repository,
    branch: &str,
) -> Result<git2::Tree<'a>, String> {
    let ref_name = if branch.starts_with("refs/") {
        branch.to_string()
    } else if branch.starts_with("origin/") {
        format!("refs/remotes/{}", branch)
    } else {
        // Try local branch first, fall back to remote
        if repo
            .find_reference(&format!("refs/heads/{}", branch))
            .is_ok()
        {
            format!("refs/heads/{}", branch)
        } else {
            format!("refs/remotes/origin/{}", branch)
        }
    };

    let reference = repo
        .find_reference(&ref_name)
        .map_err(|e| format!("Failed to find branch '{}' (ref: {}): {}", branch, ref_name, e))?;

    reference
        .peel_to_tree()
        .map_err(|e| format!("Failed to peel branch '{}' to tree: {}", branch, e))
}

// ---------------------------------------------------------------------------
// 1. resolve_parent_branch — find the upstream ref to diff against
// ---------------------------------------------------------------------------

/// Determine the best parent branch reference for diff comparisons.
///
/// ─── ARCHITECTURE DECISION: Remote-first, ALWAYS ───────────────────
/// We ALWAYS prefer `origin/<branch>` over local `<branch>`. This is
/// NOT a fallback strategy — it's the intended behavior. The entire
/// diff pipeline depends on this:
///
///   1. Workspace creation fetches `origin/<parent>` and branches from it
///      (see backend/src/routes/workspaces.ts — POST /workspaces)
///   2. Diffs show "what changed in this workspace vs upstream"
///   3. PRs target the remote branch, so diffs match what the PR shows
///
/// If you change this to local-first, every workspace that has diverged
/// from its remote will show phantom file changes. DO NOT change this
/// without understanding the full workspace creation → diff → PR flow.
/// ────────────────────────────────────────────────────────────────────
///
/// Candidate order: `parent_branch`, `default_branch`, "main", "master", "develop".
/// For each candidate: tries `origin/{name}` first, then `refs/heads/{name}`.
/// Results are cached for 5 seconds.
pub fn resolve_parent_branch(
    workspace_path: &str,
    parent_branch: Option<&str>,
    default_branch: Option<&str>,
) -> String {
    // Build a cache key from all inputs
    let cache_key = format!(
        "{}:{}:{}",
        workspace_path,
        parent_branch.unwrap_or(""),
        default_branch.unwrap_or("")
    );

    if let Some(cached) = cache_get(&cache_key) {
        return cached;
    }

    // Build ordered candidate list (deduplicated)
    let mut candidates: Vec<&str> = Vec::with_capacity(5);
    if let Some(b) = parent_branch {
        if !b.is_empty() {
            candidates.push(b);
        }
    }
    if let Some(b) = default_branch {
        if !b.is_empty() && !candidates.contains(&b) {
            candidates.push(b);
        }
    }
    for fallback in &["main", "master", "develop"] {
        if !candidates.contains(fallback) {
            candidates.push(fallback);
        }
    }

    for candidate in &candidates {
        // Try remote first (origin/{candidate}) — worktrees are created from
        // remote branches, so diffs should be against the upstream target.
        // Uses git CLI (not libgit2) for reliable worktree ref resolution.
        let remote_ref = if candidate.starts_with("origin/") {
            format!("refs/remotes/{}", candidate)
        } else if candidate.starts_with("refs/") {
            candidate.to_string()
        } else {
            format!("refs/remotes/origin/{}", candidate)
        };

        if run_git(workspace_path, &["rev-parse", "--verify", &remote_ref]).is_ok() {
            let result = if candidate.starts_with("origin/") || candidate.starts_with("refs/") {
                candidate.to_string()
            } else {
                format!("origin/{}", candidate)
            };
            cache_set(cache_key, result.clone());
            return result;
        }

        // Fall back to local (refs/heads/{candidate})
        if !candidate.starts_with("origin/") && !candidate.starts_with("refs/") {
            let local_ref = format!("refs/heads/{}", candidate);
            if run_git(workspace_path, &["rev-parse", "--verify", &local_ref]).is_ok() {
                let result = candidate.to_string();
                cache_set(cache_key, result.clone());
                return result;
            }
        }
    }

    // Nothing matched -- return best-effort default
    let result = "origin/main".to_string();
    cache_set(cache_key, result.clone());
    result
}

// ---------------------------------------------------------------------------
// 2. get_diff_stats — aggregate { additions, deletions } for sidebar badges
// ---------------------------------------------------------------------------

/// Get aggregate addition/deletion counts between the merge-base and the
/// current working directory state (committed + staged + unstaged + untracked).
///
/// Uses git CLI (`git diff --numstat`) instead of libgit2 because libgit2's
/// `diff_tree_to_workdir_with_index` has issues with git worktrees that cause
/// phantom diffs (thousands of false deletions).
pub fn get_diff_stats(workspace_path: &str, parent_branch: &str) -> Result<DiffStats, String> {
    let merge_base = compute_merge_base_sha(workspace_path, parent_branch)?;

    // Tracked file changes: git diff <merge-base> --numstat (long timeout for big repos)
    let numstat = run_git_long(workspace_path, &["diff", &merge_base, "--numstat"])?;

    let mut additions = 0u32;
    let mut deletions = 0u32;

    for line in numstat.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 2 {
            // Binary files show "-" instead of numbers
            additions += parts[0].parse::<u32>().unwrap_or(0);
            deletions += parts[1].parse::<u32>().unwrap_or(0);
        }
    }

    // Untracked files (new files not yet git-added by agents)
    for file in collect_untracked_files(workspace_path) {
        additions += file.additions;
    }

    Ok(DiffStats {
        additions,
        deletions,
    })
}

// ---------------------------------------------------------------------------
// 3. get_changed_files — per-file change list for the "Changes" tab
// ---------------------------------------------------------------------------

/// Get per-file addition/deletion counts between the merge-base and the
/// current working directory state (committed + staged + unstaged + untracked).
///
/// Uses git CLI instead of libgit2 to avoid phantom diffs in worktrees.
/// Caps results at MAX_CHANGED_FILES to prevent UI freeze.
pub fn get_changed_files(
    workspace_path: &str,
    parent_branch: &str,
) -> Result<ChangedFilesResult, String> {
    let merge_base = compute_merge_base_sha(workspace_path, parent_branch)?;

    let numstat = run_git_long(workspace_path, &["diff", &merge_base, "--numstat"])?;

    let mut files: Vec<DiffFile> = Vec::new();

    for line in numstat.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            files.push(DiffFile {
                file: parts[2].to_string(),
                additions: parts[0].parse().unwrap_or(0),
                deletions: parts[1].parse().unwrap_or(0),
            });
        }
    }

    // Add untracked files (new files not yet git-added by agents)
    files.extend(collect_untracked_files(workspace_path));

    let total_count = files.len();
    let truncated = total_count > MAX_CHANGED_FILES;
    if truncated {
        files.truncate(MAX_CHANGED_FILES);
    }

    Ok(ChangedFilesResult {
        files,
        truncated,
        total_count,
    })
}

// ---------------------------------------------------------------------------
// 4. get_file_patch — unified diff patch for a single file
// ---------------------------------------------------------------------------

/// Get the unified diff patch for a single file between the merge-base and
/// the current working directory state.
///
/// Uses git CLI instead of libgit2 to avoid phantom diffs in worktrees.
/// For untracked files, generates a synthetic diff showing the full file content.
pub fn get_file_patch(
    workspace_path: &str,
    parent_branch: &str,
    file_path: &str,
) -> Result<String, String> {
    let merge_base = compute_merge_base_sha(workspace_path, parent_branch)?;

    // Try tracked file diff
    let patch = run_git_raw(workspace_path, &["diff", &merge_base, "--", file_path])
        .unwrap_or_default();

    if !patch.trim().is_empty() {
        return Ok(patch);
    }

    // Check if it's an untracked file (exists in workdir but not tracked by git)
    let full_path = std::path::Path::new(workspace_path).join(file_path);
    if full_path.exists() {
        let is_untracked = run_git(
            workspace_path,
            &["ls-files", "--error-unmatch", file_path],
        )
        .is_err();

        if is_untracked {
            // Generate synthetic diff for untracked file
            let content = std::fs::read_to_string(&full_path).unwrap_or_default();
            let lines: Vec<&str> = content.lines().collect();
            let n = lines.len();
            let mut diff = format!(
                "diff --git a/{f} b/{f}\nnew file mode 100644\n--- /dev/null\n+++ b/{f}\n@@ -0,0 +1,{n} @@\n",
                f = file_path,
                n = n,
            );
            for line in &lines {
                diff.push('+');
                diff.push_str(line);
                diff.push('\n');
            }
            return Ok(diff);
        }
    }

    // No changes for this file
    Ok(String::new())
}

// ---------------------------------------------------------------------------
// 5. get_git_file_content
// ---------------------------------------------------------------------------

/// Retrieve the content of a file at a specific git ref (branch, tag, commit, or tree-ish).
///
/// Uses `revparse_single("{ref}:{file_path}")` to locate the blob.
/// Returns `Ok(None)` when the file does not exist at the given ref.
pub fn get_git_file_content(
    workspace_path: &str,
    git_ref: &str,
    file_path: &str,
) -> Result<Option<String>, String> {
    let repo = Repository::open(workspace_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let spec = format!("{}:{}", git_ref, file_path);
    let obj = match repo.revparse_single(&spec) {
        Ok(o) => o,
        Err(e) => {
            // NotFound means the file simply doesn't exist at that ref
            if e.code() == git2::ErrorCode::NotFound {
                return Ok(None);
            }
            return Err(format!("Failed to find '{}': {}", spec, e));
        }
    };

    let blob = obj
        .peel_to_blob()
        .map_err(|e| format!("Object at '{}' is not a blob: {}", spec, e))?;

    let content = String::from_utf8_lossy(blob.content()).into_owned();
    Ok(Some(content))
}

// ---------------------------------------------------------------------------
// 6. get_merge_base
// ---------------------------------------------------------------------------

/// Find the merge-base commit between HEAD and the given parent branch.
/// Returns the hex SHA-1 of the merge-base commit.
/// Uses git CLI for correct worktree handling.
pub fn get_merge_base(workspace_path: &str, parent_branch: &str) -> Result<String, String> {
    compute_merge_base_sha(workspace_path, parent_branch)
}

// ---------------------------------------------------------------------------
// 7. detect_default_branch
// ---------------------------------------------------------------------------

/// Detect the default branch of the repository.
///
/// Strategy 1: Read `refs/remotes/origin/HEAD` and parse the target.
/// Strategy 2: Check for common branch names ("main", "master").
/// Fallback: "main".
pub fn detect_default_branch(root_path: &str) -> String {
    let repo = match Repository::open(root_path) {
        Ok(r) => r,
        Err(_) => return "main".to_string(),
    };

    // Strategy 1: origin/HEAD symbolic reference
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            // target looks like "refs/remotes/origin/main"
            if let Some(branch) = target.strip_prefix("refs/remotes/origin/") {
                return branch.to_string();
            }
        }
        // If it's a direct reference, try resolving
        if let Ok(resolved) = reference.resolve() {
            if let Some(name) = resolved.name() {
                if let Some(branch) = name.strip_prefix("refs/remotes/origin/") {
                    return branch.to_string();
                }
            }
        }
    }

    // Strategy 2: probe for common branch names
    for candidate in &["main", "master"] {
        let remote_ref = format!("refs/remotes/origin/{}", candidate);
        let local_ref = format!("refs/heads/{}", candidate);
        if repo.find_reference(&remote_ref).is_ok() || repo.find_reference(&local_ref).is_ok() {
            return candidate.to_string();
        }
    }

    // Fallback
    "main".to_string()
}

// ---------------------------------------------------------------------------
// 8. verify_branch_exists
// ---------------------------------------------------------------------------

/// Verify that a branch exists and return the first matching ref name.
///
/// Tries in order:
///   1. refs/heads/{branch}
///   2. refs/remotes/origin/{branch}
///   3. refs/heads/main
///   4. refs/heads/master
///
/// Falls back to "main" if nothing is found.
pub fn verify_branch_exists(root_path: &str, branch: &str) -> String {
    let repo = match Repository::open(root_path) {
        Ok(r) => r,
        Err(_) => return "main".to_string(),
    };

    let candidates = [
        format!("refs/heads/{}", branch),
        format!("refs/remotes/origin/{}", branch),
        "refs/heads/main".to_string(),
        "refs/heads/master".to_string(),
    ];

    for candidate in &candidates {
        if repo.find_reference(candidate).is_ok() {
            // Return a human-friendly name rather than full refspec
            if let Some(stripped) = candidate.strip_prefix("refs/heads/") {
                return stripped.to_string();
            }
            if let Some(stripped) = candidate.strip_prefix("refs/remotes/") {
                return stripped.to_string();
            }
            return candidate.clone();
        }
    }

    "main".to_string()
}

// ---------------------------------------------------------------------------
// 9. list_branches — enumerate local and remote branches for UI selectors
// ---------------------------------------------------------------------------

/// List all branches in the repository, de-duplicated and sorted.
///
/// Remote branches have the `origin/` prefix stripped for display.
/// When both a local and remote branch share the same name, only the
/// local entry is returned (it's the one the user interacts with).
pub fn list_branches(workspace_path: &str) -> Result<Vec<BranchInfo>, String> {
    let repo = Repository::open(workspace_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let head_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut branches: Vec<BranchInfo> = Vec::new();

    // Local branches first (they take priority over remote duplicates)
    if let Ok(local_iter) = repo.branches(Some(BranchType::Local)) {
        for entry in local_iter {
            if let Ok((branch, _)) = entry {
                if let Some(name) = branch.name().ok().flatten() {
                    let name = name.to_string();
                    let is_head = head_name.as_deref() == Some(&name);
                    seen.insert(name.clone());
                    branches.push(BranchInfo {
                        name,
                        is_remote: false,
                        is_head,
                    });
                }
            }
        }
    }

    // Remote branches (skip duplicates already seen as local)
    if let Ok(remote_iter) = repo.branches(Some(BranchType::Remote)) {
        for entry in remote_iter {
            if let Ok((branch, _)) = entry {
                if let Some(full_name) = branch.name().ok().flatten() {
                    // Strip "origin/" prefix for display
                    let display_name = full_name
                        .strip_prefix("origin/")
                        .unwrap_or(full_name)
                        .to_string();

                    // Skip HEAD pointer and branches already seen locally
                    if display_name == "HEAD" || seen.contains(&display_name) {
                        continue;
                    }

                    seen.insert(display_name.clone());
                    branches.push(BranchInfo {
                        name: display_name,
                        is_remote: true,
                        is_head: false,
                    });
                }
            }
        }
    }

    branches.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(branches)
}

// ---------------------------------------------------------------------------
// 10. get_uncommitted_files — HEAD → workdir diff (staged + unstaged + untracked)
// ---------------------------------------------------------------------------

/// Get per-file changes that are NOT yet committed (exist in workdir but not HEAD).
/// Diffs HEAD tree → working directory instead of merge-base → workdir.
/// This captures staged, unstaged, and untracked changes only.
pub fn get_uncommitted_files(workspace_path: &str) -> Result<Vec<DiffFile>, String> {
    let repo = Repository::open(workspace_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let head_tree = repo
        .head()
        .and_then(|h| h.peel_to_tree())
        .map_err(|e| format!("Failed to get HEAD tree: {}", e))?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);

    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut opts))
        .map_err(|e| format!("Failed to compute HEAD→workdir diff: {}", e))?;

    collect_diff_files(&diff)
}

// ---------------------------------------------------------------------------
// 11. get_last_turn_files — checkpoint ref → workdir diff
// ---------------------------------------------------------------------------

/// Get per-file changes since the last turn checkpoint.
/// Finds the latest `refs/hive-checkpoints/session-{session_id}-turn-*-start` ref,
/// diffs that tree → working directory.
pub fn get_last_turn_files(
    workspace_path: &str,
    session_id: &str,
) -> Result<Vec<DiffFile>, String> {
    let repo = Repository::open(workspace_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let prefix = format!("refs/hive-checkpoints/session-{}-turn-", session_id);
    let mut latest_ref: Option<(String, git2::Oid, i64)> = None;

    // Find the most recent checkpoint by commit timestamp (not ref name).
    // Ref names embed turnId which may not be zero-padded (e.g. "turn-9" vs
    // "turn-10"), so lexicographic comparison would pick the wrong ref after
    // 10+ turns. Comparing committer timestamps is always correct.
    repo.references_glob(&format!("{}*-start", prefix))
        .map_err(|e| format!("Failed to list checkpoint refs: {}", e))?
        .for_each(|r| {
            if let Ok(reference) = r {
                if let Some(oid) = reference.target() {
                    let commit_time = repo
                        .find_commit(oid)
                        .map(|c| c.time().seconds())
                        .unwrap_or(0);
                    if latest_ref
                        .as_ref()
                        .map_or(true, |(_, _, t)| commit_time > *t)
                    {
                        let name = reference.name().unwrap_or("").to_string();
                        latest_ref = Some((name, oid, commit_time));
                    }
                }
            }
        });

    let (_, checkpoint_oid, _) = latest_ref
        .ok_or_else(|| "No turn checkpoints found for this session".to_string())?;

    let checkpoint_commit = repo
        .find_commit(checkpoint_oid)
        .map_err(|e| format!("Failed to find checkpoint commit: {}", e))?;

    let checkpoint_tree = checkpoint_commit
        .tree()
        .map_err(|e| format!("Failed to get checkpoint tree: {}", e))?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);

    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&checkpoint_tree), Some(&mut opts))
        .map_err(|e| format!("Failed to compute checkpoint→workdir diff: {}", e))?;

    collect_diff_files(&diff)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Extract per-file stats from a git2::Diff object.
fn collect_diff_files(diff: &git2::Diff) -> Result<Vec<DiffFile>, String> {
    let mut files: Vec<DiffFile> = Vec::new();

    let num_deltas = diff.deltas().len();
    for idx in 0..num_deltas {
        let patch = match git2::Patch::from_diff(diff, idx) {
            Ok(Some(p)) => p,
            Ok(None) => continue,
            Err(_) => continue,
        };

        let delta = patch.delta();
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        let (mut additions, mut deletions) = (0u32, 0u32);
        let num_hunks = patch.num_hunks();
        for hunk_idx in 0..num_hunks {
            let (hunk, num_lines) = match patch.hunk(hunk_idx) {
                Ok(h) => h,
                Err(_) => continue,
            };
            let _ = hunk;
            for line_idx in 0..num_lines {
                if let Ok(line) = patch.line_in_hunk(hunk_idx, line_idx) {
                    match line.origin() {
                        '+' => additions += 1,
                        '-' => deletions += 1,
                        _ => {}
                    }
                }
            }
        }

        files.push(DiffFile {
            file: file_path,
            additions,
            deletions,
        });
    }

    Ok(files)
}

// resolve_branch_oid and get_merge_base_tree removed — diff pipeline now uses
// git CLI via compute_merge_base_sha() + `git diff --numstat` instead of
// libgit2's diff_tree_to_workdir_with_index which had phantom diff issues
// in worktrees. Both Conductor and Codex use git CLI for diffs.

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::fs;
    use tempfile::TempDir;

    // -----------------------------------------------------------------------
    // Test helpers — create git repos with controlled state
    // -----------------------------------------------------------------------

    /// Commit helper: stage all files and create a commit.
    fn commit_all(repo: &Repository, message: &str) -> git2::Oid {
        let sig = Signature::now("Test", "test@test.com").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["."], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();

        let parent: Vec<git2::Commit> = match repo.head() {
            Ok(head) => vec![head.peel_to_commit().unwrap()],
            Err(_) => vec![],
        };
        let parent_refs: Vec<&git2::Commit> = parent.iter().collect();

        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
            .unwrap()
    }

    /// Create a repo with a main branch and a feature branch that has changes.
    ///
    /// Commit history:
    ///   main:    C1 (README.md = "hello world\n", src/lib.rs = "fn main() {}\n")
    ///   feature: C1 → C2 (README.md modified, new_file.txt added, src/lib.rs deleted)
    ///
    /// Returns (TempDir, path_string) — TempDir must be kept alive.
    fn create_diverged_repo() -> (TempDir, String) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_str().unwrap().to_string();
        let repo = Repository::init(&path).unwrap();

        // --- main branch: initial commit ---
        fs::write(dir.path().join("README.md"), "hello world\n").unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/lib.rs"), "fn main() {}\n").unwrap();
        commit_all(&repo, "Initial commit");

        // Rename default branch to "main" (git init creates "master" on some systems)
        let head = repo.head().unwrap();
        let head_target = head.target().unwrap();
        repo.branch("main", &repo.find_commit(head_target).unwrap(), true)
            .unwrap();
        repo.set_head("refs/heads/main").unwrap();

        // --- feature branch: diverge with changes ---
        repo.branch(
            "feature",
            &repo.find_commit(head_target).unwrap(),
            false,
        )
        .unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        // Modify README
        fs::write(dir.path().join("README.md"), "hello world\nupdated line\n").unwrap();
        // Add new file
        fs::write(dir.path().join("new_file.txt"), "brand new content\n").unwrap();
        // Delete src/lib.rs
        fs::remove_file(dir.path().join("src/lib.rs")).unwrap();

        commit_all(&repo, "Feature changes");

        (dir, path)
    }

    /// Create a simple repo with just a main branch (no feature branch).
    fn create_simple_repo() -> (TempDir, String) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_str().unwrap().to_string();
        let repo = Repository::init(&path).unwrap();

        fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        let oid = commit_all(&repo, "Initial");

        repo.branch("main", &repo.find_commit(oid).unwrap(), true)
            .unwrap();
        repo.set_head("refs/heads/main").unwrap();

        (dir, path)
    }

    // -----------------------------------------------------------------------
    // Cache tests
    // -----------------------------------------------------------------------

    #[test]
    fn cache_set_and_get() {
        cache_set("test_key_1".to_string(), "test_value".to_string());
        assert_eq!(cache_get("test_key_1"), Some("test_value".to_string()));
    }

    #[test]
    fn cache_miss_returns_none() {
        assert_eq!(cache_get("definitely_nonexistent_key_xyz"), None);
    }

    // -----------------------------------------------------------------------
    // Serialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn diff_stats_serializes_correctly() {
        let stats = DiffStats {
            additions: 10,
            deletions: 5,
        };
        let json = serde_json::to_string(&stats).unwrap();
        assert!(json.contains("\"additions\":10"));
        assert!(json.contains("\"deletions\":5"));
    }

    #[test]
    fn diff_file_serializes_correctly() {
        let file = DiffFile {
            file: "src/main.rs".to_string(),
            additions: 3,
            deletions: 1,
        };
        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains("\"file\":\"src/main.rs\""));
        assert!(json.contains("\"additions\":3"));
    }

    #[test]
    fn file_diff_result_serializes_correctly() {
        let result = FileDiffResult {
            file: "README.md".to_string(),
            diff: "+hello\n-world".to_string(),
            old_content: Some("world".to_string()),
            new_content: Some("hello".to_string()),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"file\":\"README.md\""));
        assert!(json.contains("\"old_content\":\"world\""));
        assert!(json.contains("\"new_content\":\"hello\""));
    }

    // -----------------------------------------------------------------------
    // Fallback / error path tests (no repo)
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_parent_branch_no_repo_falls_back() {
        let result = resolve_parent_branch("/nonexistent/path/abc123", None, None);
        assert_eq!(result, "origin/main");
    }

    #[test]
    fn detect_default_branch_no_repo_falls_back() {
        let result = detect_default_branch("/nonexistent/path/abc123");
        assert_eq!(result, "main");
    }

    #[test]
    fn verify_branch_exists_no_repo_falls_back() {
        let result = verify_branch_exists("/nonexistent/path/abc123", "develop");
        assert_eq!(result, "main");
    }

    #[test]
    fn get_diff_stats_invalid_repo_returns_error() {
        let result = get_diff_stats("/nonexistent/path", "main");
        assert!(result.is_err());
    }

    #[test]
    fn get_changed_files_invalid_repo_returns_error() {
        let result = get_changed_files("/nonexistent/path", "main");
        assert!(result.is_err());
    }

    #[test]
    fn get_file_patch_invalid_repo_returns_error() {
        let result = get_file_patch("/nonexistent/path", "main", "README.md");
        assert!(result.is_err());
    }

    #[test]
    fn get_merge_base_invalid_repo_returns_error() {
        let result = get_merge_base("/nonexistent/path", "main");
        assert!(result.is_err());
    }

    #[test]
    fn get_git_file_content_invalid_repo_returns_error() {
        let result = get_git_file_content("/nonexistent/path", "HEAD", "file.txt");
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // resolve_parent_branch with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_parent_branch_finds_local_branch() {
        let (_dir, path) = create_diverged_repo();
        let result = resolve_parent_branch(&path, Some("main"), None);
        assert_eq!(result, "main");
    }

    #[test]
    fn resolve_parent_branch_skips_missing_and_falls_back() {
        let (_dir, path) = create_diverged_repo();
        // "nonexistent" doesn't exist, should fall through to "main"
        let result = resolve_parent_branch(&path, Some("nonexistent"), Some("main"));
        assert_eq!(result, "main");
    }

    #[test]
    fn resolve_parent_branch_uses_default_branch_fallback() {
        let (_dir, path) = create_simple_repo();
        // No parent_branch given, default_branch = "main"
        let result = resolve_parent_branch(&path, None, Some("main"));
        assert_eq!(result, "main");
    }

    #[test]
    fn resolve_parent_branch_finds_main_in_hardcoded_fallbacks() {
        let (_dir, path) = create_simple_repo();
        // Both parent and default are empty — should find "main" via fallback list
        let result = resolve_parent_branch(&path, Some(""), Some(""));
        assert_eq!(result, "main");
    }

    // -----------------------------------------------------------------------
    // detect_default_branch with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn detect_default_branch_finds_main() {
        let (_dir, path) = create_simple_repo();
        let result = detect_default_branch(&path);
        assert_eq!(result, "main");
    }

    #[test]
    fn detect_default_branch_finds_master_when_no_main() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_str().unwrap().to_string();
        let repo = Repository::init(&path).unwrap();
        fs::write(dir.path().join("file.txt"), "content\n").unwrap();
        commit_all(&repo, "Initial");

        // git init may create "main" or "master" depending on system config.
        // Ensure we end up with only "master" and no "main".
        let head_ref = repo.head().unwrap();
        let head_commit = head_ref.peel_to_commit().unwrap();
        let head_name = head_ref.shorthand().unwrap_or("").to_string();
        drop(head_ref);

        if head_name == "main" {
            // System defaulted to "main" — create master, switch, delete main
            repo.branch("master", &head_commit, false).unwrap();
            repo.set_head("refs/heads/master").unwrap();
            repo.find_branch("main", git2::BranchType::Local)
                .unwrap()
                .delete()
                .unwrap();
        }
        // If head_name is already "master", we're already in the right state

        let result = detect_default_branch(&path);
        assert_eq!(result, "master");
    }

    // -----------------------------------------------------------------------
    // verify_branch_exists with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn verify_branch_exists_finds_existing_branch() {
        let (_dir, path) = create_diverged_repo();
        let result = verify_branch_exists(&path, "feature");
        assert_eq!(result, "feature");
    }

    #[test]
    fn verify_branch_exists_falls_back_to_main() {
        let (_dir, path) = create_diverged_repo();
        let result = verify_branch_exists(&path, "nonexistent-branch");
        assert_eq!(result, "main");
    }

    // -----------------------------------------------------------------------
    // get_diff_stats with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn get_diff_stats_counts_changes() {
        let (_dir, path) = create_diverged_repo();
        let stats = get_diff_stats(&path, "main").unwrap();
        // README.md: +1 line added ("updated line\n")
        // new_file.txt: +1 line added ("brand new content\n")
        // src/lib.rs: -1 line deleted ("fn main() {}\n")
        assert!(stats.additions > 0, "Expected additions > 0, got {}", stats.additions);
        assert!(stats.deletions > 0, "Expected deletions > 0, got {}", stats.deletions);
    }

    #[test]
    fn get_diff_stats_no_changes_returns_zeros() {
        let (_dir, path) = create_simple_repo();
        // HEAD is on main, diffing main against itself via merge-base → no changes
        let stats = get_diff_stats(&path, "main").unwrap();
        assert_eq!(stats.additions, 0);
        assert_eq!(stats.deletions, 0);
    }

    #[test]
    fn get_diff_stats_nonexistent_branch_degrades_gracefully() {
        let (_dir, path) = create_simple_repo();
        // With git CLI, merge-base falls back to HEAD when branch doesn't exist.
        // This means diff shows only uncommitted changes (zero for clean repo).
        let result = get_diff_stats(&path, "nonexistent-branch");
        assert!(result.is_ok(), "Should degrade gracefully, got: {:?}", result);
        let stats = result.unwrap();
        assert_eq!(stats.additions, 0);
        assert_eq!(stats.deletions, 0);
    }

    // -----------------------------------------------------------------------
    // get_changed_files with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn get_changed_files_lists_changed_files() {
        let (_dir, path) = create_diverged_repo();
        let files = get_changed_files(&path, "main").unwrap();

        let file_names: Vec<&str> = files.files.iter().map(|f| f.file.as_str()).collect();

        // Should include README.md (modified), new_file.txt (added), src/lib.rs (deleted)
        assert!(
            file_names.contains(&"README.md"),
            "Expected README.md in {:?}",
            file_names
        );
        assert!(
            file_names.contains(&"new_file.txt"),
            "Expected new_file.txt in {:?}",
            file_names
        );
        assert!(
            file_names.contains(&"src/lib.rs"),
            "Expected src/lib.rs in {:?}",
            file_names
        );
    }

    #[test]
    fn get_changed_files_returns_per_file_stats() {
        let (_dir, path) = create_diverged_repo();
        let files = get_changed_files(&path, "main").unwrap();

        let new_file = files.files.iter().find(|f| f.file == "new_file.txt").unwrap();
        assert!(new_file.additions > 0, "new_file.txt should have additions");
        assert_eq!(new_file.deletions, 0, "new_file.txt should have no deletions");

        let deleted_file = files.files.iter().find(|f| f.file == "src/lib.rs").unwrap();
        assert_eq!(deleted_file.additions, 0, "src/lib.rs should have no additions");
        assert!(deleted_file.deletions > 0, "src/lib.rs should have deletions");
    }

    #[test]
    fn get_changed_files_no_changes_returns_empty() {
        let (_dir, path) = create_simple_repo();
        let files = get_changed_files(&path, "main").unwrap();
        assert!(files.files.is_empty());
    }

    // -----------------------------------------------------------------------
    // get_file_patch with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn get_file_patch_returns_patch_for_modified_file() {
        let (_dir, path) = create_diverged_repo();
        let diff = get_file_patch(&path, "main", "README.md").unwrap();
        // Should contain the added line with '+' prefix (unified diff format)
        assert!(
            diff.contains("+updated line"),
            "Diff should contain '+updated line' (unified diff format), got: {}",
            diff
        );
    }

    #[test]
    fn get_file_patch_returns_patch_for_new_file() {
        let (_dir, path) = create_diverged_repo();
        let diff = get_file_patch(&path, "main", "new_file.txt").unwrap();
        assert!(
            diff.contains("brand new content"),
            "Diff for new file should contain its content, got: {}",
            diff
        );
        // Verify unified diff format: new file lines must have '+' prefix
        assert!(
            diff.contains("+brand new content"),
            "New file lines should have '+' prefix for proper unified diff format, got: {}",
            diff
        );
    }

    #[test]
    fn get_file_patch_returns_empty_for_unchanged_file() {
        let (_dir, path) = create_simple_repo();
        let diff = get_file_patch(&path, "main", "README.md").unwrap();
        assert!(diff.is_empty(), "Expected empty diff, got: {}", diff);
    }

    // -----------------------------------------------------------------------
    // get_git_file_content with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn get_git_file_content_reads_file_at_head() {
        let (_dir, path) = create_diverged_repo();
        // HEAD is on feature branch where README was modified
        let content = get_git_file_content(&path, "HEAD", "README.md").unwrap();
        assert_eq!(content, Some("hello world\nupdated line\n".to_string()));
    }

    #[test]
    fn get_git_file_content_reads_file_at_branch() {
        let (_dir, path) = create_diverged_repo();
        // On main branch, README is the original version
        let content = get_git_file_content(&path, "main", "README.md").unwrap();
        assert_eq!(content, Some("hello world\n".to_string()));
    }

    #[test]
    fn get_git_file_content_returns_none_for_missing_file() {
        let (_dir, path) = create_diverged_repo();
        // new_file.txt doesn't exist on main branch
        let content = get_git_file_content(&path, "main", "new_file.txt").unwrap();
        assert_eq!(content, None);
    }

    #[test]
    fn get_git_file_content_reads_new_file_at_head() {
        let (_dir, path) = create_diverged_repo();
        let content = get_git_file_content(&path, "HEAD", "new_file.txt").unwrap();
        assert_eq!(content, Some("brand new content\n".to_string()));
    }

    #[test]
    fn get_git_file_content_deleted_file_missing_at_head() {
        let (_dir, path) = create_diverged_repo();
        // src/lib.rs was deleted on feature branch (HEAD)
        let content = get_git_file_content(&path, "HEAD", "src/lib.rs").unwrap();
        assert_eq!(content, None);
    }

    #[test]
    fn get_git_file_content_deleted_file_exists_at_main() {
        let (_dir, path) = create_diverged_repo();
        let content = get_git_file_content(&path, "main", "src/lib.rs").unwrap();
        assert_eq!(content, Some("fn main() {}\n".to_string()));
    }

    // -----------------------------------------------------------------------
    // get_merge_base with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn get_merge_base_returns_common_ancestor() {
        let (_dir, path) = create_diverged_repo();
        let result = get_merge_base(&path, "main").unwrap();
        // Should return a 40-char hex SHA
        assert_eq!(result.len(), 40, "Expected SHA hash, got: {}", result);
        assert!(
            result.chars().all(|c| c.is_ascii_hexdigit()),
            "Expected hex SHA, got: {}",
            result
        );
    }

    #[test]
    fn get_merge_base_same_branch_returns_head() {
        let (_dir, path) = create_simple_repo();
        // Merging main with itself — merge-base is HEAD
        let result = get_merge_base(&path, "main").unwrap();
        assert_eq!(result.len(), 40);
    }

    // -----------------------------------------------------------------------
    // resolve_branch_tree (tested indirectly through diff functions)
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_branch_tree_handles_refs_heads_prefix() {
        let (_dir, path) = create_diverged_repo();
        let repo = Repository::open(&path).unwrap();
        // Explicit refs/heads/main format should work
        let tree = resolve_branch_tree(&repo, "refs/heads/main");
        assert!(tree.is_ok(), "Should resolve refs/heads/main");
    }

    #[test]
    fn resolve_branch_tree_handles_plain_name() {
        let (_dir, path) = create_diverged_repo();
        let repo = Repository::open(&path).unwrap();
        // Plain "main" should resolve via refs/heads/main fallback
        let tree = resolve_branch_tree(&repo, "main");
        assert!(tree.is_ok(), "Should resolve plain 'main'");
    }

    #[test]
    fn resolve_branch_tree_errors_for_nonexistent() {
        let (_dir, path) = create_simple_repo();
        let repo = Repository::open(&path).unwrap();
        let tree = resolve_branch_tree(&repo, "nonexistent-branch");
        assert!(tree.is_err());
    }

    // -----------------------------------------------------------------------
    // Integration: full diff workflow
    // -----------------------------------------------------------------------

    #[test]
    fn full_diff_workflow_stats_match_files() {
        let (_dir, path) = create_diverged_repo();
        let stats = get_diff_stats(&path, "main").unwrap();
        let files = get_changed_files(&path, "main").unwrap();

        // Sum of per-file stats should equal aggregate stats
        let total_additions: u32 = files.files.iter().map(|f| f.additions).sum();
        let total_deletions: u32 = files.files.iter().map(|f| f.deletions).sum();

        assert_eq!(
            stats.additions, total_additions,
            "Aggregate additions ({}) should match sum of per-file additions ({})",
            stats.additions, total_additions
        );
        assert_eq!(
            stats.deletions, total_deletions,
            "Aggregate deletions ({}) should match sum of per-file deletions ({})",
            stats.deletions, total_deletions
        );
    }

    #[test]
    fn full_diff_workflow_file_content_matches() {
        let (_dir, path) = create_diverged_repo();
        let merge_base = get_merge_base(&path, "main").unwrap();

        // Old content at merge-base should be original README
        let old = get_git_file_content(&path, &merge_base, "README.md").unwrap();
        assert_eq!(old, Some("hello world\n".to_string()));

        // New content at HEAD should be modified README
        let new = get_git_file_content(&path, "HEAD", "README.md").unwrap();
        assert_eq!(new, Some("hello world\nupdated line\n".to_string()));
    }

    #[test]
    fn full_diff_workflow_new_file_old_content_is_none() {
        let (_dir, path) = create_diverged_repo();
        let merge_base = get_merge_base(&path, "main").unwrap();

        // new_file.txt didn't exist at merge-base
        let old = get_git_file_content(&path, &merge_base, "new_file.txt").unwrap();
        assert_eq!(old, None);

        // But it exists at HEAD
        let new = get_git_file_content(&path, "HEAD", "new_file.txt").unwrap();
        assert!(new.is_some());
    }

    #[test]
    fn full_diff_workflow_deleted_file_new_content_is_none() {
        let (_dir, path) = create_diverged_repo();
        let merge_base = get_merge_base(&path, "main").unwrap();

        // src/lib.rs existed at merge-base
        let old = get_git_file_content(&path, &merge_base, "src/lib.rs").unwrap();
        assert_eq!(old, Some("fn main() {}\n".to_string()));

        // But deleted at HEAD
        let new = get_git_file_content(&path, "HEAD", "src/lib.rs").unwrap();
        assert_eq!(new, None);
    }

    // -----------------------------------------------------------------------
    // Working directory diff tests
    //
    // These verify that diffs capture uncommitted, staged, and untracked
    // changes — the core behavior added when switching from
    // diff_tree_to_tree to diff_tree_to_workdir_with_index.
    // -----------------------------------------------------------------------

    /// Create a repo where HEAD == main (no committed divergence), but the
    /// working directory has modifications and untracked files.
    /// Tree-to-tree diffs would show zero changes; workdir diffs must detect them.
    fn create_repo_with_workdir_changes() -> (TempDir, String) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_str().unwrap().to_string();
        let repo = Repository::init(&path).unwrap();

        // Initial commit on main
        fs::write(dir.path().join("README.md"), "hello world\n").unwrap();
        fs::write(dir.path().join("existing.txt"), "line one\nline two\n").unwrap();
        let oid = commit_all(&repo, "Initial commit");

        // Ensure branch is named "main"
        repo.branch("main", &repo.find_commit(oid).unwrap(), true)
            .unwrap();
        repo.set_head("refs/heads/main").unwrap();

        // Create feature branch at same commit (no divergence)
        repo.branch("feature", &repo.find_commit(oid).unwrap(), false)
            .unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        // --- Working directory changes (NOT committed) ---
        // Modify a tracked file
        fs::write(
            dir.path().join("existing.txt"),
            "line one\nline two\nline three\n",
        )
        .unwrap();
        // Create an untracked file
        fs::write(dir.path().join("untracked.txt"), "new untracked content\n").unwrap();

        (dir, path)
    }

    #[test]
    fn workdir_diff_detects_changes_even_without_commits() {
        // KEY TEST: HEAD and main point to the same commit, but there are
        // working directory changes. Old tree-to-tree diffs would return 0/0.
        let (_dir, path) = create_repo_with_workdir_changes();

        // Verify HEAD and main share the same commit (no committed divergence)
        let merge_base = get_merge_base(&path, "main").unwrap();
        let repo = Repository::open(&path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let base = repo
            .find_commit(git2::Oid::from_str(&merge_base).unwrap())
            .unwrap();
        assert_eq!(
            head.id(),
            base.id(),
            "HEAD and merge-base should be the same commit"
        );

        // Despite same commit, diff should show working directory changes
        let stats = get_diff_stats(&path, "main").unwrap();
        assert!(
            stats.additions > 0,
            "Workdir diff should detect uncommitted changes even when HEAD == merge-base, got additions={}",
            stats.additions
        );

        let files = get_changed_files(&path, "main").unwrap();
        assert!(
            !files.files.is_empty(),
            "Workdir diff should list changed files even when HEAD == merge-base"
        );
    }

    #[test]
    fn get_diff_stats_includes_uncommitted_modifications() {
        let (_dir, path) = create_repo_with_workdir_changes();
        let stats = get_diff_stats(&path, "main").unwrap();
        // existing.txt: +1 line ("line three\n"), untracked.txt: +1 line
        assert!(
            stats.additions >= 2,
            "Expected at least 2 additions (uncommitted + untracked), got {}",
            stats.additions
        );
    }

    #[test]
    fn get_changed_files_includes_uncommitted_modification() {
        let (_dir, path) = create_repo_with_workdir_changes();
        let files = get_changed_files(&path, "main").unwrap();
        let names: Vec<&str> = files.files.iter().map(|f| f.file.as_str()).collect();
        assert!(
            names.contains(&"existing.txt"),
            "Expected uncommitted modified file in {:?}",
            names
        );
    }

    #[test]
    fn get_changed_files_includes_untracked_file() {
        let (_dir, path) = create_repo_with_workdir_changes();
        let files = get_changed_files(&path, "main").unwrap();
        let names: Vec<&str> = files.files.iter().map(|f| f.file.as_str()).collect();
        assert!(
            names.contains(&"untracked.txt"),
            "Expected untracked file in {:?}",
            names
        );
    }

    #[test]
    fn get_file_patch_includes_uncommitted_modification() {
        let (_dir, path) = create_repo_with_workdir_changes();
        let diff = get_file_patch(&path, "main", "existing.txt").unwrap();
        assert!(
            diff.contains("+line three"),
            "Patch should contain '+line three' (unified diff format), got: {}",
            diff
        );
    }

    #[test]
    fn get_file_patch_includes_untracked_file_content() {
        let (_dir, path) = create_repo_with_workdir_changes();
        let diff = get_file_patch(&path, "main", "untracked.txt").unwrap();
        assert!(
            diff.contains("+new untracked content"),
            "Patch should contain untracked file content, got: {}",
            diff
        );
    }

    #[test]
    fn get_diff_stats_includes_staged_uncommitted_changes() {
        let (dir, path) = create_repo_with_workdir_changes();
        let repo = Repository::open(&path).unwrap();

        // Stage a new file (git add) but don't commit
        fs::write(dir.path().join("staged.txt"), "staged content\n").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new("staged.txt"))
            .unwrap();
        index.write().unwrap();

        let stats = get_diff_stats(&path, "main").unwrap();
        // staged.txt (1 line) + existing.txt (1 line) + untracked.txt (1 line) = at least 3
        assert!(
            stats.additions >= 3,
            "Expected at least 3 additions (uncommitted + staged + untracked), got {}",
            stats.additions
        );

        let files = get_changed_files(&path, "main").unwrap();
        let names: Vec<&str> = files.files.iter().map(|f| f.file.as_str()).collect();
        assert!(
            names.contains(&"staged.txt"),
            "Expected staged file in {:?}",
            names
        );
    }

    #[test]
    fn get_diff_stats_combines_committed_and_uncommitted() {
        let (dir, path) = create_diverged_repo();

        // Diverged repo has committed changes — capture baseline
        let committed_stats = get_diff_stats(&path, "main").unwrap();
        let committed_additions = committed_stats.additions;

        // Add an uncommitted untracked file on top
        fs::write(dir.path().join("extra.txt"), "extra line\n").unwrap();

        let total_stats = get_diff_stats(&path, "main").unwrap();
        assert!(
            total_stats.additions > committed_additions,
            "Expected more additions after uncommitted change: {} should be > {}",
            total_stats.additions,
            committed_additions
        );
    }
}
