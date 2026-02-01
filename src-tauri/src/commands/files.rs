use crate::files::{FILE_SCANNER, FileTreeResponse};

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
