// Git Operations Module
//
// Pure git2-based operations for diff computation, branch resolution,
// and file content retrieval. These are stateless functions that open
// the repository on each call (fast -- libgit2 caches internally).
//
// DIFF SEMANTICS:
// All diffs compare the merge-base tree to the WORKING DIRECTORY (not HEAD).
// This captures committed + staged + unstaged + untracked changes -- important
// because AI agents often leave uncommitted working tree changes.
//
// Steps:
//   1. resolve_parent_branch() -> finds upstream ref (prefers origin/*, never local-first)
//   2. get_merge_base_tree()   -> finds fork point (merge-base of HEAD and upstream)
//   3. diff_tree_to_workdir_with_index(merge_base_tree) -> all changes since fork
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

use git2::{DiffFormat, DiffOptions, Repository};
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
pub struct FileDiffResult {
    pub file: String,
    pub diff: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
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
// Helper: resolve a branch name to a git2::Tree
// ---------------------------------------------------------------------------

/// Resolve a branch string to its tree object.
///
/// Handles multiple formats:
///   - "origin/main"            -> refs/remotes/origin/main
///   - "refs/remotes/origin/…"  -> used as-is
///   - "refs/heads/…"           -> used as-is
///   - "main"                   -> tries refs/heads/main, then refs/remotes/origin/main
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

/// Determine the best parent branch for diff comparisons.
///
/// Tries remote branches first (`origin/{name}`), then local (`refs/heads/{name}`).
/// Remote is preferred because worktrees are created from remote branches and
/// diffs should show what changed relative to the upstream target.
/// Candidate order: `parent_branch`, `default_branch`, "main", "master", "develop".
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

    let repo = match Repository::open(workspace_path) {
        Ok(r) => r,
        Err(_) => return "origin/main".to_string(),
    };

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
        let remote_ref = if candidate.starts_with("origin/") {
            format!("refs/remotes/{}", candidate)
        } else if candidate.starts_with("refs/") {
            candidate.to_string()
        } else {
            format!("refs/remotes/origin/{}", candidate)
        };

        if repo.find_reference(&remote_ref).is_ok() {
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
            if repo.find_reference(&local_ref).is_ok() {
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
/// Uses `diff_tree_to_workdir_with_index` so that uncommitted changes made by
/// AI agents are included in sidebar diff stats badges.
pub fn get_diff_stats(workspace_path: &str, parent_branch: &str) -> Result<DiffStats, String> {
    let repo = Repository::open(workspace_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let base_tree = get_merge_base_tree(&repo, parent_branch)?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);

    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&base_tree), Some(&mut opts))
        .map_err(|e| format!("Failed to compute diff: {}", e))?;

    let stats = diff
        .stats()
        .map_err(|e| format!("Failed to get diff stats: {}", e))?;

    Ok(DiffStats {
        additions: stats.insertions() as u32,
        deletions: stats.deletions() as u32,
    })
}

// ---------------------------------------------------------------------------
// 3. get_changed_files — per-file change list for the "Changes" tab
// ---------------------------------------------------------------------------

/// Get per-file addition/deletion counts between the merge-base and the
/// current working directory state (committed + staged + unstaged + untracked).
pub fn get_changed_files(
    workspace_path: &str,
    parent_branch: &str,
) -> Result<Vec<DiffFile>, String> {
    let repo = Repository::open(workspace_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let base_tree = get_merge_base_tree(&repo, parent_branch)?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);

    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&base_tree), Some(&mut opts))
        .map_err(|e| format!("Failed to compute diff: {}", e))?;

    let mut files: Vec<DiffFile> = Vec::new();

    // Iterate over each patch (one per file) to collect per-file stats
    let num_deltas = diff.deltas().len();
    for idx in 0..num_deltas {
        let patch = match git2::Patch::from_diff(&diff, idx) {
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
            let _ = hunk; // hunk header not needed for stats
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

// ---------------------------------------------------------------------------
// 4. get_file_patch — unified diff patch for a single file
// ---------------------------------------------------------------------------

/// Get the unified diff patch for a single file between the merge-base and
/// the current working directory state.
pub fn get_file_patch(
    workspace_path: &str,
    parent_branch: &str,
    file_path: &str,
) -> Result<String, String> {
    let repo = Repository::open(workspace_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let base_tree = get_merge_base_tree(&repo, parent_branch)?;

    let mut diff_opts = DiffOptions::new();
    diff_opts.pathspec(file_path);
    diff_opts.context_lines(3);
    diff_opts.include_untracked(true);
    diff_opts.recurse_untracked_dirs(true);
    diff_opts.show_untracked_content(true);

    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&base_tree), Some(&mut diff_opts))
        .map_err(|e| format!("Failed to compute diff: {}", e))?;

    // Build patch as raw bytes then decode lossily (handles binary/invalid UTF-8)
    let mut patch_bytes: Vec<u8> = Vec::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        patch_bytes.extend_from_slice(line.content());
        true
    })
    .map_err(|e| format!("Failed to format diff: {}", e))?;

    Ok(String::from_utf8_lossy(&patch_bytes).into_owned())
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
/// Returns the hex SHA-1 of the merge-base commit, or falls back to the
/// parent branch name on error.
pub fn get_merge_base(workspace_path: &str, parent_branch: &str) -> Result<String, String> {
    let repo = Repository::open(workspace_path)
        .map_err(|e| format!("Failed to open repository: {}", e))?;

    let head_oid = repo
        .head()
        .and_then(|h| h.resolve())
        .map(|r| r.target().unwrap())
        .map_err(|e| format!("Failed to resolve HEAD: {}", e))?;

    let parent_oid = resolve_branch_oid(&repo, parent_branch)?;

    match repo.merge_base(head_oid, parent_oid) {
        Ok(oid) => Ok(oid.to_string()),
        Err(_) => {
            // Fallback: return the parent branch identifier so callers
            // can still attempt a diff (graceful degradation).
            Ok(parent_branch.to_string())
        }
    }
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
// Internal helpers
// ---------------------------------------------------------------------------

/// Resolve a branch name to its OID (commit hash).
fn resolve_branch_oid(repo: &Repository, branch: &str) -> Result<git2::Oid, String> {
    let ref_name = if branch.starts_with("refs/") {
        branch.to_string()
    } else if branch.starts_with("origin/") {
        format!("refs/remotes/{}", branch)
    } else {
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

    let resolved = reference
        .resolve()
        .map_err(|e| format!("Failed to resolve ref '{}': {}", ref_name, e))?;

    resolved
        .target()
        .ok_or_else(|| format!("Reference '{}' has no target OID", ref_name))
}

/// Get the tree at the fork point — where this workspace diverged from the
/// upstream branch. This is the baseline for all diff operations.
///
/// Implements merge-base semantics:
///   fork_point = merge_base(HEAD, upstream)
///   tree = commit_at(fork_point).tree()
///
/// All diff functions compare this tree to the working directory, giving
/// "everything that changed since we forked."
///
/// Falls back to the upstream branch tree directly if merge-base fails
/// (e.g., unrelated histories).
fn get_merge_base_tree<'a>(
    repo: &'a Repository,
    parent_branch: &str,
) -> Result<git2::Tree<'a>, String> {
    let head_oid = repo
        .head()
        .and_then(|h| h.resolve())
        .ok()
        .and_then(|r| r.target());

    let parent_oid = resolve_branch_oid(repo, parent_branch).ok();

    // Attempt merge-base resolution
    if let (Some(h), Some(p)) = (head_oid, parent_oid) {
        if let Ok(merge_oid) = repo.merge_base(h, p) {
            if let Ok(commit) = repo.find_commit(merge_oid) {
                if let Ok(tree) = commit.tree() {
                    return Ok(tree);
                }
            }
        }
    }

    // Fallback: use parent branch tree directly
    resolve_branch_tree(repo, parent_branch)
}

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
        assert!(result.unwrap_err().contains("Failed to open repository"));
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
    fn get_diff_stats_nonexistent_branch_errors() {
        let (_dir, path) = create_simple_repo();
        let result = get_diff_stats(&path, "nonexistent-branch");
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // get_changed_files with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn get_changed_files_lists_changed_files() {
        let (_dir, path) = create_diverged_repo();
        let files = get_changed_files(&path, "main").unwrap();

        let file_names: Vec<&str> = files.iter().map(|f| f.file.as_str()).collect();

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

        let new_file = files.iter().find(|f| f.file == "new_file.txt").unwrap();
        assert!(new_file.additions > 0, "new_file.txt should have additions");
        assert_eq!(new_file.deletions, 0, "new_file.txt should have no deletions");

        let deleted_file = files.iter().find(|f| f.file == "src/lib.rs").unwrap();
        assert_eq!(deleted_file.additions, 0, "src/lib.rs should have no additions");
        assert!(deleted_file.deletions > 0, "src/lib.rs should have deletions");
    }

    #[test]
    fn get_changed_files_no_changes_returns_empty() {
        let (_dir, path) = create_simple_repo();
        let files = get_changed_files(&path, "main").unwrap();
        assert!(files.is_empty());
    }

    // -----------------------------------------------------------------------
    // get_file_patch with real repos
    // -----------------------------------------------------------------------

    #[test]
    fn get_file_patch_returns_patch_for_modified_file() {
        let (_dir, path) = create_diverged_repo();
        let diff = get_file_patch(&path, "main", "README.md").unwrap();
        // Should contain the added line
        assert!(
            diff.contains("updated line"),
            "Diff should contain 'updated line', got: {}",
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
        let total_additions: u32 = files.iter().map(|f| f.additions).sum();
        let total_deletions: u32 = files.iter().map(|f| f.deletions).sum();

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
            !files.is_empty(),
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
        let names: Vec<&str> = files.iter().map(|f| f.file.as_str()).collect();
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
        let names: Vec<&str> = files.iter().map(|f| f.file.as_str()).collect();
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
            diff.contains("line three"),
            "Patch should contain uncommitted change 'line three', got: {}",
            diff
        );
    }

    #[test]
    fn get_file_patch_includes_untracked_file_content() {
        let (_dir, path) = create_repo_with_workdir_changes();
        let diff = get_file_patch(&path, "main", "untracked.txt").unwrap();
        assert!(
            diff.contains("new untracked content"),
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
        let names: Vec<&str> = files.iter().map(|f| f.file.as_str()).collect();
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
