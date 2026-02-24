use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use crate::error::SimulatorError;
use crate::types::InstalledApp;

/// Callback for streaming build log output line-by-line.
pub type BuildLogCallback = Arc<dyn Fn(&str) + Send + Sync>;

/// One-shot build-install-launch from a workspace directory.
/// Auto-detects .xcworkspace/.xcodeproj, picks a scheme, builds for the
/// given simulator, installs, and launches. Returns the installed app info.
pub async fn build_and_run(
    workspace_path: &str,
    udid: &str,
    on_log: Option<BuildLogCallback>,
) -> Result<InstalledApp, SimulatorError> {
    let log_line = |msg: &str| {
        if let Some(ref cb) = on_log {
            cb(msg);
        }
    };

    // 1-2. Find Xcode project + detect scheme (blocking filesystem I/O + subprocesses)
    log_line("Searching for Xcode project...");
    let (xcode_project, is_workspace, scheme) = {
        let ws_path = workspace_path.to_string();
        let on_log_clone = on_log.clone();
        tokio::task::spawn_blocking(move || {
            let log = |msg: &str| {
                if let Some(ref cb) = on_log_clone { cb(msg); }
            };
            let (xcode_project, is_workspace) = find_xcode_project(&ws_path)
                .ok_or_else(|| SimulatorError::BuildFailed {
                    reason: format!(
                        "No .xcworkspace or .xcodeproj found under {} (searched up to 3 levels deep). \
                         If this project uses XcodeGen, make sure `xcodegen` is installed.",
                        ws_path
                    ),
                })?;
            log::info!("Found Xcode project: {}", xcode_project.display());
            log(&format!(
                "Found: {}",
                xcode_project.file_name().unwrap_or_default().to_string_lossy()
            ));

            let scheme = find_scheme(&xcode_project, is_workspace)?;
            log::info!("Using scheme: {}", scheme);
            log(&format!("Scheme: {}", scheme));

            Ok::<_, SimulatorError>((xcode_project, is_workspace, scheme))
        })
        .await
        .map_err(|e| SimulatorError::BuildFailed {
            reason: format!("Task join error: {}", e),
        })??
    };

    // 3. Build with xcodebuild
    let app_path = run_xcodebuild(
        &xcode_project,
        is_workspace,
        &scheme,
        udid,
        workspace_path,
        on_log.clone(),
    )
    .await?;

    log::info!("Built .app at: {}", app_path);
    log_line("Build succeeded");

    // 4. Install on simulator
    log_line("Installing on simulator...");
    let installed = install_app(udid, &app_path).await?;

    // 5. Launch
    log_line(&format!("Launching {}...", installed.name));
    launch_app(udid, &installed.bundle_id).await?;

    Ok(installed)
}

/// Find .xcworkspace or .xcodeproj by searching the workspace directory tree.
/// Searches up to 3 levels deep. Prefers .xcworkspace (Pods-aware). Skips Pods.xcworkspace.
/// Also detects XcodeGen projects (project.yml) and runs `xcodegen generate` to create
/// the .xcodeproj before returning.
pub fn find_xcode_project(workspace_path: &str) -> Option<(PathBuf, bool)> {
    let root = PathBuf::from(workspace_path);

    // Collect candidate directories (up to 3 levels deep)
    let mut dirs_to_search = Vec::new();
    collect_candidate_dirs(&root, 0, 3, &mut dirs_to_search);

    // Pass 1: look for existing .xcworkspace / .xcodeproj
    for dir in &dirs_to_search {
        if let Some(result) = scan_dir_for_xcode_project(dir) {
            return Some(result);
        }
    }

    // Pass 2: look for XcodeGen project.yml, generate .xcodeproj, then re-scan
    for dir in &dirs_to_search {
        let project_yml = dir.join("project.yml");
        if project_yml.exists() {
            log::info!(
                "Found XcodeGen project.yml at {}, running xcodegen generate",
                dir.display()
            );
            let status = Command::new("xcodegen")
                .arg("generate")
                .current_dir(dir)
                .status();
            match status {
                Ok(s) if s.success() => {
                    log::info!("xcodegen generate succeeded in {}", dir.display());
                    if let Some(result) = scan_dir_for_xcode_project(dir) {
                        return Some(result);
                    }
                }
                Ok(s) => {
                    log::warn!(
                        "xcodegen generate exited with {} in {}",
                        s,
                        dir.display()
                    );
                }
                Err(e) => {
                    log::warn!(
                        "xcodegen not found or failed to run in {}: {}",
                        dir.display(),
                        e
                    );
                }
            }
        }
    }

    None
}

/// Fast, side-effect-free probe: does this workspace contain a buildable Xcode project?
/// Same 3-level-deep search as `find_xcode_project` but skips XcodeGen generation
/// (Pass 2) to avoid blocking on a subprocess. Checks for project.yml existence
/// as a signal that the project *can* be built, without running xcodegen.
pub fn has_xcode_project(workspace_path: &str) -> bool {
    let root = PathBuf::from(workspace_path);
    let mut dirs = Vec::new();
    collect_candidate_dirs(&root, 0, 3, &mut dirs);

    // Check for existing .xcworkspace / .xcodeproj
    for dir in &dirs {
        if scan_dir_for_xcode_project(dir).is_some() {
            return true;
        }
    }

    // Check for XcodeGen project.yml (buildable, even if not yet generated)
    for dir in &dirs {
        if dir.join("project.yml").exists() {
            return true;
        }
    }

    false
}

/// Recursively collect directories to search, up to `max_depth` levels.
/// Skips hidden dirs, node_modules, Pods, build, and other noise.
fn collect_candidate_dirs(dir: &Path, depth: u32, max_depth: u32, out: &mut Vec<PathBuf>) {
    if !dir.is_dir() {
        return;
    }
    out.push(dir.to_path_buf());

    if depth >= max_depth {
        return;
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden dirs, deps, build artifacts, and Xcode bundles
            if name.starts_with('.')
                || name == "node_modules"
                || name == "Pods"
                || name == "build"
                || name == "DerivedData"
                || name == "vendor"
                || name.ends_with(".xcworkspace")
                || name.ends_with(".xcodeproj")
            {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                collect_candidate_dirs(&path, depth + 1, max_depth, out);
            }
        }
    }
}

/// Scan a single directory for .xcworkspace (preferred) or .xcodeproj.
fn scan_dir_for_xcode_project(dir: &Path) -> Option<(PathBuf, bool)> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        // Collect entries so we can iterate twice (workspace first, then project)
        let entries: Vec<_> = entries.flatten().collect();

        // Prefer .xcworkspace (CocoaPods-aware)
        for entry in &entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".xcworkspace") && !name.starts_with("Pods") {
                return Some((entry.path(), true));
            }
        }

        // Fallback to .xcodeproj
        for entry in &entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".xcodeproj") {
                return Some((entry.path(), false));
            }
        }
    }
    None
}

/// Detect schemes from the Xcode project. Returns the first scheme found,
/// or falls back to the project basename.
fn find_scheme(xcode_project: &Path, is_workspace: bool) -> Result<String, SimulatorError> {
    // Try xcshareddata/xcschemes/ directory
    let schemes_dir = xcode_project.join("xcshareddata/xcschemes");
    if schemes_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&schemes_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".xcscheme") {
                    return Ok(name.trim_end_matches(".xcscheme").to_string());
                }
            }
        }
    }

    // Fallback: use xcodebuild -list to get schemes
    let flag = if is_workspace { "-workspace" } else { "-project" };
    let project_str = xcode_project.to_string_lossy().to_string();

    let output = Command::new("xcodebuild")
        .args([flag, &project_str, "-list"])
        .output()
        .map_err(|e| SimulatorError::BuildFailed {
            reason: format!("xcodebuild -list failed: {}", e),
        })?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse "Schemes:" section
        let mut in_schemes = false;
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed == "Schemes:" {
                in_schemes = true;
                continue;
            }
            if in_schemes {
                if trimmed.is_empty() || trimmed.ends_with(':') {
                    break;
                }
                return Ok(trimmed.to_string());
            }
        }
    }

    // Final fallback: project basename
    let name = xcode_project
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("App")
        .to_string();
    Ok(name)
}

/// Run xcodebuild, find the output .app path, return it.
/// If SPM package resolution fails due to corrupted cache, cleans the
/// SourcePackages/repositories directory and retries once.
async fn run_xcodebuild(
    xcode_project: &Path,
    is_workspace: bool,
    scheme: &str,
    udid: &str,
    workspace_path: &str,
    on_log: Option<BuildLogCallback>,
) -> Result<String, SimulatorError> {
    // First attempt
    let result = run_xcodebuild_once(xcode_project, is_workspace, scheme, udid, workspace_path, on_log.clone()).await;

    if let Err(SimulatorError::BuildFailed { ref reason }) = result {
        // Detect SPM cache corruption — retry once after cleaning
        if is_spm_cache_error(reason) {
            log::warn!("SPM cache error detected, cleaning SourcePackages and retrying");
            if let Some(repos_dir) = extract_spm_repos_dir(reason) {
                log::info!("Cleaning {}", repos_dir.display());
                let _ = std::fs::remove_dir_all(&repos_dir);
            }
            return run_xcodebuild_once(xcode_project, is_workspace, scheme, udid, workspace_path, on_log).await;
        }
    }

    result
}

/// Returns true if the build error looks like a corrupted SPM SourcePackages cache.
fn is_spm_cache_error(reason: &str) -> bool {
    let lower = reason.to_lowercase();
    (lower.contains("could not resolve package dependencies")
        || lower.contains("already exists unexpectedly")
        || lower.contains("could not lock config file"))
        && lower.contains("sourcepackages")
}

/// Try to extract the SourcePackages/repositories path from the error text.
/// Looks for paths like `.../DerivedData/.../SourcePackages/repositories/...`
/// and returns the `repositories` directory.
fn extract_spm_repos_dir(reason: &str) -> Option<PathBuf> {
    for word in reason.split_whitespace() {
        // Also handle paths that end with a single-quote from error formatting
        let cleaned = word.trim_matches(|c: char| c == '\'' || c == '"');
        if let Some(idx) = cleaned.find("SourcePackages/repositories") {
            let repos_dir = &cleaned[..idx + "SourcePackages/repositories".len()];
            let path = PathBuf::from(repos_dir);
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

/// Single xcodebuild invocation (no retry logic).
/// Streams stdout/stderr lines via `on_log` callback for real-time build output.
async fn run_xcodebuild_once(
    xcode_project: &Path,
    is_workspace: bool,
    scheme: &str,
    udid: &str,
    workspace_path: &str,
    on_log: Option<BuildLogCallback>,
) -> Result<String, SimulatorError> {
    let flag = if is_workspace { "-workspace" } else { "-project" };
    let project_str = xcode_project.to_string_lossy().to_string();
    let scheme_owned = scheme.to_string();
    let destination = format!("id={}", udid);
    let workspace_owned = workspace_path.to_string();

    // Build with streaming output (stdout/stderr read line-by-line)
    let (success, all_output) = tokio::task::spawn_blocking(move || {
        let mut child = Command::new("xcodebuild")
            .args([
                flag,
                &project_str,
                "-scheme",
                &scheme_owned,
                "-configuration",
                "Debug",
                "-destination",
                &destination,
                "-destination-timeout",
                "1",
                "build",
            ])
            .current_dir(&workspace_owned)
            .env("RCT_NO_LAUNCH_PACKAGER", "true")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SimulatorError::BuildFailed {
                reason: format!("xcodebuild failed to start: {}", e),
            })?;

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        // Read stderr in a background thread to prevent pipe deadlocks
        let on_log_for_stderr = on_log.clone();
        let stderr_thread = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut lines = Vec::new();
            for line in reader.lines().map_while(Result::ok) {
                if let Some(ref cb) = on_log_for_stderr {
                    cb(&line);
                }
                lines.push(line);
            }
            lines
        });

        // Read stdout on the current thread
        let mut stdout_lines = Vec::new();
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(ref cb) = on_log {
                cb(&line);
            }
            stdout_lines.push(line);
        }

        // Collect stderr and wait for process
        let stderr_lines = stderr_thread.join().unwrap_or_default();
        let status = child.wait().map_err(|e| SimulatorError::BuildFailed {
            reason: format!("xcodebuild wait failed: {}", e),
        })?;

        let mut all_output = stdout_lines;
        all_output.extend(stderr_lines);

        Ok::<_, SimulatorError>((status.success(), all_output))
    })
    .await
    .map_err(|e| SimulatorError::BuildFailed {
        reason: format!("task join failed: {}", e),
    })??;

    if !success {
        // Take last 20 lines for context
        let context: String = all_output
            .iter()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");

        return Err(SimulatorError::BuildFailed {
            reason: format!("xcodebuild failed:\n{}", context),
        });
    }

    // Find the .app output path via -showBuildSettings
    let flag2 = if is_workspace { "-workspace" } else { "-project" };
    let project_str2 = xcode_project.to_string_lossy().to_string();
    let scheme_owned2 = scheme.to_string();
    let destination2 = format!("id={}", udid);

    let settings_output = tokio::task::spawn_blocking(move || {
        Command::new("xcodebuild")
            .args([
                flag2,
                &project_str2,
                "-scheme",
                &scheme_owned2,
                "-configuration",
                "Debug",
                "-destination",
                &destination2,
                "-showBuildSettings",
                "-json",
            ])
            .output()
            .map_err(|e| SimulatorError::BuildFailed {
                reason: format!("showBuildSettings failed: {}", e),
            })
    })
    .await
    .map_err(|e| SimulatorError::BuildFailed {
        reason: format!("task join failed: {}", e),
    })??;

    if !settings_output.status.success() {
        return Err(SimulatorError::BuildFailed {
            reason: "Failed to read build settings".to_string(),
        });
    }

    // Parse JSON build settings to find TARGET_BUILD_DIR + EXECUTABLE_FOLDER_PATH
    let json: serde_json::Value =
        serde_json::from_slice(&settings_output.stdout).map_err(|e| {
            SimulatorError::BuildFailed {
                reason: format!("Failed to parse build settings JSON: {}", e),
            }
        })?;

    // xcodebuild -showBuildSettings -json returns an array of targets
    if let Some(targets) = json.as_array() {
        for target in targets {
            let settings = &target["buildSettings"];
            // Find the target that produces an .app bundle
            if settings["WRAPPER_EXTENSION"].as_str() == Some("app") {
                let build_dir = settings["TARGET_BUILD_DIR"]
                    .as_str()
                    .ok_or_else(|| SimulatorError::BuildFailed {
                        reason: "TARGET_BUILD_DIR not found in build settings".to_string(),
                    })?;
                let folder_path = settings["EXECUTABLE_FOLDER_PATH"]
                    .as_str()
                    .ok_or_else(|| SimulatorError::BuildFailed {
                        reason: "EXECUTABLE_FOLDER_PATH not found in build settings".to_string(),
                    })?;
                let app_path = format!("{}/{}", build_dir, folder_path);
                if Path::new(&app_path).exists() {
                    return Ok(app_path);
                }
            }
        }
    }

    Err(SimulatorError::BuildFailed {
        reason: "Could not find built .app in build output".to_string(),
    })
}

/// Install a .app bundle onto a booted simulator via `xcrun simctl install`.
/// Extracts bundle metadata (bundle_id, name) from Info.plist before install.
pub async fn install_app(udid: &str, app_path: &str) -> Result<InstalledApp, SimulatorError> {
    // Validate the .app bundle exists and has Info.plist
    let path = Path::new(app_path);
    if !path.exists() || !path.is_dir() {
        return Err(SimulatorError::InvalidAppBundle {
            path: app_path.to_string(),
            reason: "path does not exist or is not a directory".to_string(),
        });
    }
    if !app_path.ends_with(".app") {
        return Err(SimulatorError::InvalidAppBundle {
            path: app_path.to_string(),
            reason: "path must end with .app".to_string(),
        });
    }
    let info_plist = path.join("Info.plist");
    if !info_plist.exists() {
        return Err(SimulatorError::InvalidAppBundle {
            path: app_path.to_string(),
            reason: "Info.plist not found in bundle".to_string(),
        });
    }

    // Extract metadata before install
    let bundle_id = get_bundle_id(app_path).await?;
    let name = get_app_name(app_path).await?;

    // Install via simctl
    let udid_owned = udid.to_string();
    let app_path_owned = app_path.to_string();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "install", &udid_owned, &app_path_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl install failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SimulatorError::InstallFailed {
            bundle_id: bundle_id.clone(),
            reason: stderr.trim().to_string(),
        });
    }

    log::info!("Installed {} ({}) on simulator {}", name, bundle_id, udid);

    Ok(InstalledApp {
        bundle_id,
        name,
        app_path: app_path.to_string(),
    })
}

/// Launch an installed app on a booted simulator via `xcrun simctl launch`.
pub async fn launch_app(udid: &str, bundle_id: &str) -> Result<(), SimulatorError> {
    let udid_owned = udid.to_string();
    let bundle_id_owned = bundle_id.to_string();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "launch", &udid_owned, &bundle_id_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl launch failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SimulatorError::LaunchFailed {
            bundle_id: bundle_id.to_string(),
            reason: stderr.trim().to_string(),
        });
    }

    log::info!("Launched {} on simulator {}", bundle_id, udid);
    Ok(())
}

/// Terminate a running app on the simulator via `xcrun simctl terminate`.
/// Non-fatal if the app is not running.
pub async fn terminate_app(udid: &str, bundle_id: &str) -> Result<(), SimulatorError> {
    let udid_owned = udid.to_string();
    let bundle_id_owned = bundle_id.to_string();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "terminate", &udid_owned, &bundle_id_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl terminate failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Not running is fine — idempotent terminate
        log::warn!("Terminate {} warning: {}", bundle_id, stderr.trim());
    }

    Ok(())
}

/// Uninstall an app from the simulator via `xcrun simctl uninstall`.
/// Non-fatal if the app is not installed.
pub async fn uninstall_app(udid: &str, bundle_id: &str) -> Result<(), SimulatorError> {
    let udid_owned = udid.to_string();
    let bundle_id_owned = bundle_id.to_string();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "uninstall", &udid_owned, &bundle_id_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl uninstall failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Not installed is fine — idempotent uninstall
        log::warn!("Uninstall {} warning: {}", bundle_id, stderr.trim());
    }

    Ok(())
}

/// Read CFBundleIdentifier from an .app bundle's Info.plist via PlistBuddy.
async fn get_bundle_id(app_path: &str) -> Result<String, SimulatorError> {
    let info_plist = format!("{}/Info.plist", app_path);
    let plist_path = info_plist.clone();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print:CFBundleIdentifier", &plist_path])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("PlistBuddy failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        return Err(SimulatorError::InvalidAppBundle {
            path: app_path.to_string(),
            reason: "could not read CFBundleIdentifier from Info.plist".to_string(),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Read display name from an .app bundle's Info.plist.
/// Tries CFBundleDisplayName first, falls back to CFBundleName, then directory name.
async fn get_app_name(app_path: &str) -> Result<String, SimulatorError> {
    let info_plist = format!("{}/Info.plist", app_path);

    // Try CFBundleDisplayName first
    let plist_path = info_plist.clone();
    let display_output = tokio::task::spawn_blocking(move || {
        Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print:CFBundleDisplayName", &plist_path])
            .output()
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    if let Some(output) = display_output {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return Ok(name);
            }
        }
    }

    // Fallback to CFBundleName
    let plist_path = info_plist.clone();
    let name_output = tokio::task::spawn_blocking(move || {
        Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print:CFBundleName", &plist_path])
            .output()
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    if let Some(output) = name_output {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return Ok(name);
            }
        }
    }

    // Final fallback: directory name without .app
    let dir_name = Path::new(app_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();
    Ok(dir_name)
}
