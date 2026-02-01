use std::path::Path;

#[derive(serde::Serialize)]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub path: String,
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
                apps.push(InstalledApp {
                    id: id.to_string(),
                    name: name.to_string(),
                    path: path.to_string(),
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
