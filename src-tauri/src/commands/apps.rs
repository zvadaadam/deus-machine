use std::path::Path;

#[derive(serde::Serialize)]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Base64-encoded PNG data URL of the app icon (64x64), or None if extraction failed.
    pub icon: Option<String>,
}

// Shared app definitions (id, display name, app path)
const APP_DEFINITIONS: &[(&str, &str, &str)] = &[
    // File manager
    ("finder", "Finder", "/System/Library/CoreServices/Finder.app"),

    // Code Editors
    ("cursor", "Cursor", "/Applications/Cursor.app"),
    ("vscode", "Visual Studio Code", "/Applications/Visual Studio Code.app"),
    ("windsurf", "Windsurf", "/Applications/Windsurf.app"),
    ("zed", "Zed", "/Applications/Zed.app"),
    ("sublime", "Sublime Text", "/Applications/Sublime Text.app"),
    ("nova", "Nova", "/Applications/Nova.app"),

    // JetBrains IDEs
    ("webstorm", "WebStorm", "/Applications/WebStorm.app"),
    ("intellij", "IntelliJ IDEA", "/Applications/IntelliJ IDEA.app"),
    ("pycharm", "PyCharm", "/Applications/PyCharm.app"),
    ("phpstorm", "PhpStorm", "/Applications/PhpStorm.app"),
    ("rubymine", "RubyMine", "/Applications/RubyMine.app"),
    ("goland", "GoLand", "/Applications/GoLand.app"),
    ("clion", "CLion", "/Applications/CLion.app"),
    ("fleet", "Fleet", "/Applications/Fleet.app"),
    ("rider", "Rider", "/Applications/Rider.app"),
    ("androidstudio", "Android Studio", "/Applications/Android Studio.app"),

    // Apple IDEs
    ("xcode", "Xcode", "/Applications/Xcode.app"),

    // Terminals
    ("terminal", "Terminal", "/System/Applications/Utilities/Terminal.app"),
    ("iterm", "iTerm", "/Applications/iTerm.app"),
    ("warp", "Warp", "/Applications/Warp.app"),
];

/// Extract the app icon as a base64 PNG data URL.
/// Uses PlistBuddy to find the .icns file, then sips to convert to 64x64 PNG.
#[cfg(target_os = "macos")]
fn extract_app_icon(app_path: &str, app_id: &str) -> Option<String> {
    use base64::Engine;

    let resources_dir = format!("{}/Contents/Resources", app_path);
    let plist_path = format!("{}/Contents/Info.plist", app_path);

    // Try to read CFBundleIconFile from Info.plist
    let icon_name = std::process::Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg("Print :CFBundleIconFile")
        .arg(&plist_path)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    // Build candidate paths for the .icns file
    let mut candidates = Vec::new();

    if let Some(name) = &icon_name {
        if name.ends_with(".icns") {
            candidates.push(format!("{}/{}", resources_dir, name));
        } else {
            candidates.push(format!("{}/{}.icns", resources_dir, name));
        }
    }
    // Common fallbacks
    candidates.push(format!("{}/AppIcon.icns", resources_dir));
    candidates.push(format!("{}/app.icns", resources_dir));
    candidates.push(format!("{}/Icon.icns", resources_dir));

    let icns_path = candidates.iter().find(|p| Path::new(p).exists())?;

    // Convert .icns → 64x64 PNG using sips (built into macOS)
    let tmp_path = format!("/tmp/hive_app_icon_{}.png", app_id);

    let output = std::process::Command::new("sips")
        .args([
            "-s", "format", "png",
            icns_path,
            "--out", &tmp_path,
            "--resampleHeightWidth", "64", "64",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let png_data = std::fs::read(&tmp_path).ok()?;
    let _ = std::fs::remove_file(&tmp_path);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_data);
    Some(format!("data:image/png;base64,{}", b64))
}

/// Get list of installed development apps on macOS
#[tauri::command]
pub fn get_installed_apps() -> Result<Vec<InstalledApp>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Ok(Vec::new());
    }

    #[cfg(target_os = "macos")]
    {
        let mut apps = Vec::new();

        for (id, name, path) in APP_DEFINITIONS {
            if Path::new(path).exists() {
                let icon = extract_app_icon(path, id);
                apps.push(InstalledApp {
                    id: id.to_string(),
                    name: name.to_string(),
                    path: path.to_string(),
                    icon,
                });
            }
        }

        Ok(apps)
    }
}

/// Open a workspace directory in a specific app
#[tauri::command]
pub fn open_in_app(app_id: String, workspace_path: String) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err("This feature is only available on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        // Find the app name from our shared definitions
        let app_name = APP_DEFINITIONS
            .iter()
            .find(|(id, _, _)| *id == app_id.as_str())
            .map(|(_, name, _)| *name)
            .ok_or_else(|| format!("Unknown app: {}", app_id))?;

        // Terminal apps need special handling via AppleScript
        let output = match app_id.as_str() {
            "terminal" => {
                let script = format!(
                    r#"tell application "Terminal"
                        activate
                        do script "cd '{}'"
                    end tell"#,
                    workspace_path.replace("'", "'\\''")
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| format!("Failed to open Terminal: {}", e))?
            }
            "iterm" => {
                let script = format!(
                    r#"tell application "iTerm"
                        activate
                        create window with default profile
                        tell current session of current window
                            write text "cd '{}'"
                        end tell
                    end tell"#,
                    workspace_path.replace("'", "'\\''")
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| format!("Failed to open iTerm: {}", e))?
            }
            "warp" => {
                let script = format!(
                    r#"tell application "Warp"
                        activate
                    end tell
                    do shell script "open -a Warp '{}'"#,
                    workspace_path.replace("'", "'\\''")
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| format!("Failed to open Warp: {}", e))?
            }
            // IDEs and editors work with standard open command
            _ => {
                std::process::Command::new("open")
                    .arg("-a")
                    .arg(app_name)
                    .arg(&workspace_path)
                    .output()
                    .map_err(|e| format!("Failed to open app: {}", e))?
            }
        };

        if !output.status.success() {
            return Err(format!(
                "Failed to open {}: {}",
                app_name,
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        Ok(format!("Opened in {}", app_name))
    }
}
