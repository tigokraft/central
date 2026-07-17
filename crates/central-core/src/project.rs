use std::path::PathBuf;
use std::sync::Mutex;

/// Tracks the directory of whichever project is currently open in the UI. Every
/// cwd-dependent backend call (terminals, git diff, memory records) resolves through
/// this instead of the process's own working directory, so multiple projects can't
/// bleed into each other. `None` means no project has been opened yet.
#[derive(Default)]
pub struct ProjectState(pub Mutex<Option<PathBuf>>);

#[tauri::command]
pub fn set_active_project_path(
    path: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    *state.0.lock().unwrap() = Some(PathBuf::from(path));
    Ok(())
}
