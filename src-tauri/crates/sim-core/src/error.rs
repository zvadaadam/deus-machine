/// Typed errors for simulator operations.
/// Implements Display via thiserror, and converts to String for Tauri IPC.
#[derive(Debug, thiserror::Error)]
pub enum SimulatorError {
    #[error("simctl failed: {0}")]
    Simctl(String),

    #[error("failed to boot simulator {udid}: {reason}")]
    BootFailed { udid: String, reason: String },

    #[error("failed to create simulator {name}: {reason}")]
    CreateFailed { name: String, reason: String },

    #[error("failed to erase simulator {udid}: {reason}")]
    EraseFailed { udid: String, reason: String },

    #[error("failed to delete simulator {udid}: {reason}")]
    DeleteFailed { udid: String, reason: String },

    #[error("failed to shutdown simulator {udid}: {reason}")]
    ShutdownFailed { udid: String, reason: String },

    #[error("invalid app bundle at {path}: {reason}")]
    InvalidAppBundle { path: String, reason: String },

    #[error("app install failed for {bundle_id}: {reason}")]
    InstallFailed { bundle_id: String, reason: String },

    #[error("app launch failed for {bundle_id}: {reason}")]
    LaunchFailed { bundle_id: String, reason: String },

    #[error("build failed: {reason}")]
    BuildFailed { reason: String },
}

// Tauri requires errors to be serializable as String
impl From<SimulatorError> for String {
    fn from(e: SimulatorError) -> String {
        e.to_string()
    }
}
