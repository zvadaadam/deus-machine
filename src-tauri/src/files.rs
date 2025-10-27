use std::path::{Path, PathBuf};
use std::fs;
use std::sync::Arc;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use parking_lot::RwLock;
use std::collections::HashMap;
use chrono::{DateTime, Utc};
use anyhow::{Result, Context};

//============================================================================
// TYPE DEFINITIONS (Match Frontend TypeScript)
//============================================================================

/// File tree node - matches TypeScript FileTreeNode interface
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,  // ISO 8601 timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_status: Option<GitStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitStatus {
    Modified,
    Added,
    Deleted,
    Untracked,
}

/// File tree response - matches TypeScript interface
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeResponse {
    pub files: Vec<FileNode>,
    #[serde(rename = "totalFiles")]
    pub total_files: usize,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
}

//============================================================================
// CACHE MANAGEMENT
//============================================================================

/// Cached file tree with expiration
#[derive(Debug, Clone)]
struct CachedTree {
    tree: FileTreeResponse,
    cached_at: DateTime<Utc>,
}

/// File scanner with in-memory caching
pub struct FileScanner {
    /// Cache: workspace_path -> CachedTree
    cache: Arc<RwLock<HashMap<PathBuf, CachedTree>>>,
    /// Cache TTL in seconds (default: 30s)
    cache_ttl: i64,
}

impl FileScanner {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            cache_ttl: 30, // 30 seconds cache
        }
    }

    /// Scan workspace directory and return file tree
    pub fn scan_workspace(&self, workspace_path: impl AsRef<Path>) -> Result<FileTreeResponse> {
        let workspace_path = workspace_path.as_ref().to_path_buf();

        // Check cache first
        {
            let cache = self.cache.read();
            if let Some(cached) = cache.get(&workspace_path) {
                let age = Utc::now()
                    .signed_duration_since(cached.cached_at)
                    .num_seconds();

                if age < self.cache_ttl {
                    println!("[FileScanner] Cache hit for {:?} (age: {}s)", workspace_path, age);
                    return Ok(cached.tree.clone());
                }
            }
        }

        println!("[FileScanner] Scanning workspace: {:?}", workspace_path);

        // Validate path exists
        if !workspace_path.exists() {
            anyhow::bail!("Workspace path does not exist: {:?}", workspace_path);
        }

        // Build file tree
        let files = self.build_tree(&workspace_path)?;

        // Calculate totals
        let (total_files, total_size) = self.calculate_totals(&files);

        let tree = FileTreeResponse {
            files,
            total_files,
            total_size,
        };

        // Update cache
        {
            let mut cache = self.cache.write();
            cache.insert(
                workspace_path.clone(),
                CachedTree {
                    tree: tree.clone(),
                    cached_at: Utc::now(),
                },
            );
        }

        println!("[FileScanner] Scan complete: {} files, {} bytes", total_files, total_size);
        Ok(tree)
    }

    /// Build file tree recursively with .gitignore filtering
    fn build_tree(&self, root_path: &Path) -> Result<Vec<FileNode>> {
        let mut nodes = Vec::new();

        // Use ignore crate for .gitignore-aware traversal
        let walker = WalkBuilder::new(root_path)
            .git_ignore(true)       // Respect .gitignore
            .git_exclude(true)      // Respect .git/info/exclude
            .git_global(true)       // Respect global gitignore
            .hidden(false)          // Include hidden files (except .git)
            .ignore(true)           // Respect .ignore files
            .parents(true)          // Check parent .gitignore files
            .max_depth(Some(1))     // Only scan immediate children (we'll recurse manually)
            .build();

        for entry in walker {
            let entry = entry.context("Failed to read directory entry")?;
            let path = entry.path();

            // Skip the root directory itself
            if path == root_path {
                continue;
            }

            // Skip .git directory explicitly
            if path.file_name().and_then(|s| s.to_str()) == Some(".git") {
                continue;
            }

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[FileScanner] Failed to read metadata for {:?}: {}", path, e);
                    continue;
                }
            };

            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("?")
                .to_string();

            let relative_path = path
                .strip_prefix(root_path)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            let node = if metadata.is_dir() {
                // Recursively scan directory
                let children = self.build_tree(path)?;

                FileNode {
                    name,
                    path: relative_path,
                    node_type: NodeType::Directory,
                    size: None,
                    modified: None,
                    children: Some(children),
                    git_status: None,
                }
            } else if metadata.is_file() {
                // File node with metadata
                let size = metadata.len();
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|t| {
                        let datetime: DateTime<Utc> = t.into();
                        Some(datetime.to_rfc3339())
                    });

                FileNode {
                    name,
                    path: relative_path,
                    node_type: NodeType::File,
                    size: Some(size),
                    modified,
                    children: None,
                    git_status: None,
                }
            } else {
                // Skip symlinks, sockets, etc.
                continue;
            };

            nodes.push(node);
        }

        // Sort: directories first, then alphabetically
        nodes.sort_by(|a, b| {
            match (&a.node_type, &b.node_type) {
                (NodeType::Directory, NodeType::File) => std::cmp::Ordering::Less,
                (NodeType::File, NodeType::Directory) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(nodes)
    }

    /// Calculate total file count and size recursively
    fn calculate_totals(&self, nodes: &[FileNode]) -> (usize, u64) {
        let mut file_count = 0;
        let mut total_size = 0;

        for node in nodes {
            match node.node_type {
                NodeType::File => {
                    file_count += 1;
                    total_size += node.size.unwrap_or(0);
                }
                NodeType::Directory => {
                    if let Some(children) = &node.children {
                        let (child_count, child_size) = self.calculate_totals(children);
                        file_count += child_count;
                        total_size += child_size;
                    }
                }
            }
        }

        (file_count, total_size)
    }

    /// Clear cache for a specific workspace
    pub fn invalidate_cache(&self, workspace_path: impl AsRef<Path>) {
        let mut cache = self.cache.write();
        cache.remove(workspace_path.as_ref());
    }

    /// Clear entire cache
    pub fn clear_cache(&self) {
        let mut cache = self.cache.write();
        cache.clear();
    }
}

//============================================================================
// SINGLETON INSTANCE
//============================================================================

lazy_static::lazy_static! {
    /// Global file scanner instance (singleton)
    pub static ref FILE_SCANNER: FileScanner = FileScanner::new();
}

//============================================================================
// TESTS
//============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_scan_empty_directory() {
        let temp_dir = TempDir::new().unwrap();
        let scanner = FileScanner::new();

        let result = scanner.scan_workspace(temp_dir.path()).unwrap();
        assert_eq!(result.files.len(), 0);
        assert_eq!(result.total_files, 0);
        assert_eq!(result.total_size, 0);
    }

    #[test]
    fn test_scan_with_files() {
        let temp_dir = TempDir::new().unwrap();
        let scanner = FileScanner::new();

        // Create test files
        fs::write(temp_dir.path().join("file1.txt"), "hello").unwrap();
        fs::write(temp_dir.path().join("file2.txt"), "world").unwrap();
        fs::create_dir(temp_dir.path().join("subdir")).unwrap();
        fs::write(temp_dir.path().join("subdir/file3.txt"), "test").unwrap();

        let result = scanner.scan_workspace(temp_dir.path()).unwrap();
        assert_eq!(result.total_files, 3); // 3 files total
        assert_eq!(result.files.len(), 3); // 2 files + 1 directory at root level
    }

    #[test]
    fn test_gitignore_filtering() {
        let temp_dir = TempDir::new().unwrap();
        let scanner = FileScanner::new();

        // Create .gitignore
        fs::write(temp_dir.path().join(".gitignore"), "ignored/\n*.log\n").unwrap();

        // Create files
        fs::write(temp_dir.path().join("visible.txt"), "visible").unwrap();
        fs::write(temp_dir.path().join("debug.log"), "log data").unwrap();
        fs::create_dir(temp_dir.path().join("ignored")).unwrap();
        fs::write(temp_dir.path().join("ignored/secret.txt"), "secret").unwrap();

        let result = scanner.scan_workspace(temp_dir.path()).unwrap();

        // Should only see visible.txt and .gitignore
        assert_eq!(result.total_files, 2);
        assert!(result.files.iter().any(|n| n.name == "visible.txt"));
        assert!(result.files.iter().any(|n| n.name == ".gitignore"));
        assert!(!result.files.iter().any(|n| n.name == "debug.log"));
        assert!(!result.files.iter().any(|n| n.name == "ignored"));
    }
}
