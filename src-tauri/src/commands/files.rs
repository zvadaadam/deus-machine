use crate::files::{FILE_SCANNER, FileTreeResponse, FileNode, NodeType};
use nucleo_matcher::{Matcher, Config};
use nucleo_matcher::pattern::{Pattern, CaseMatching, Normalization};
use serde::Serialize;

/// A single fuzzy search result with score and path
#[derive(Debug, Clone, Serialize)]
pub struct FuzzyFileResult {
    /// Relative path from workspace root
    pub path: String,
    /// File name only
    pub name: String,
    /// nucleo match score (higher = better match)
    pub score: u32,
}

/// Read a text file from disk and return its content
#[tauri::command]
pub fn read_text_file(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path).map_err(|e| {
        format!("Failed to read {}: {}", file_path, e)
    })
}

/// Scan workspace directory and return file tree
#[tauri::command]
pub fn scan_workspace_files(workspace_path: String) -> Result<FileTreeResponse, String> {
    println!("[COMMAND] scan_workspace_files: {}", workspace_path);

    FILE_SCANNER
        .scan_workspace(&workspace_path)
        .map_err(|e| {
            let error_msg = format!("Failed to scan workspace: {}", e);
            eprintln!("[COMMAND] {}", error_msg);
            error_msg
        })
}

/// Fuzzy file search using nucleo-matcher (Codex-style @ mentions)
///
/// Leverages the cached file tree from FileScanner and scores file paths
/// using nucleo's SIMD-optimized fuzzy matcher. Returns top results sorted
/// by score descending.
#[tauri::command]
pub fn fuzzy_file_search(
    workspace_path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<FuzzyFileResult>, String> {
    let limit = limit.unwrap_or(20);

    // Empty query → return nothing (UI should show nothing until user types)
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Get cached file tree (triggers scan if cache miss)
    let tree = FILE_SCANNER
        .scan_workspace(&workspace_path)
        .map_err(|e| format!("Failed to scan workspace: {}", e))?;

    // Flatten tree into a list of file paths
    let mut file_paths: Vec<(String, String)> = Vec::with_capacity(tree.total_files);
    flatten_file_tree(&tree.files, &mut file_paths);

    // Set up nucleo matcher with path-optimized scoring (bonuses for path separators)
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(&query, CaseMatching::Smart, Normalization::Smart);

    // Score each file path — buffer declared outside loop so Utf32Str can borrow it
    let mut buf = Vec::new();
    let mut scored: Vec<FuzzyFileResult> = file_paths
        .iter()
        .filter_map(|(path, name)| {
            buf.clear();
            let haystack = nucleo_matcher::Utf32Str::new(path, &mut buf);
            pattern.score(haystack, &mut matcher).map(|score| {
                FuzzyFileResult {
                    path: path.clone(),
                    name: name.clone(),
                    score,
                }
            })
        })
        .collect();

    // Sort by score descending
    scored.sort_by(|a, b| b.score.cmp(&a.score));

    // Truncate to limit
    scored.truncate(limit);

    Ok(scored)
}

/// Recursively flatten a FileNode tree into (path, name) pairs (files only)
fn flatten_file_tree(nodes: &[FileNode], out: &mut Vec<(String, String)>) {
    for node in nodes {
        match node.node_type {
            NodeType::File => {
                out.push((node.path.clone(), node.name.clone()));
            }
            NodeType::Directory => {
                if let Some(children) = &node.children {
                    flatten_file_tree(children, out);
                }
            }
        }
    }
}

/// Invalidate cache for a specific workspace
#[tauri::command]
pub fn invalidate_file_cache(workspace_path: String) -> Result<String, String> {
    println!("[COMMAND] invalidate_file_cache: {}", workspace_path);
    FILE_SCANNER.invalidate_cache(&workspace_path);
    Ok("Cache invalidated".to_string())
}

/// Clear entire file cache
#[tauri::command]
pub fn clear_file_cache() -> Result<String, String> {
    println!("[COMMAND] clear_file_cache");
    FILE_SCANNER.clear_cache();
    Ok("Cache cleared".to_string())
}
