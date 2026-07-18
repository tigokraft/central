use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Names never surfaced to the file explorer or watched for changes: `.git` is the project's
/// own repo metadata, `.central` is agent worktree/memory scratch space (see git_engine.rs's
/// `ensure_central_gitignored`). Both are noisy and irrelevant to "what did the agent generate."
const HIDDEN_ENTRY_NAMES: [&str; 2] = [".git", ".central"];

/// Files larger than this are refused by `read_file` rather than loaded into memory for a
/// read-only text preview.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryKind {
    File,
    Dir,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub kind: FsEntryKind,
    pub size: u64,
}

fn is_hidden_name(name: &str) -> bool {
    HIDDEN_ENTRY_NAMES.contains(&name)
}

/// Whether `candidate` is `root` or a descendant of it. Deliberately component-wise
/// (`Path::starts_with`) rather than a string-prefix check, so sibling directories that merely
/// share a string prefix (e.g. `/work` vs `/workspace2`) are never mistaken for nested paths.
fn path_is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Joins `relative` onto a project's canonicalized workspace root and verifies the result can't
/// escape that root, rejecting `..` components, absolute paths, and symlinks that resolve
/// outside the workspace. `relative` may name a path that doesn't exist yet (e.g. a file about
/// to be created), in which case the nearest existing ancestor is canonicalized and checked
/// instead of the leaf itself.
fn resolve_within_workspace(root_canonical: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(relative);
    if rel_path.is_absolute() {
        return Err("Path must be relative to the workspace".to_string());
    }
    for component in rel_path.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("Path traversal ('..') is not allowed".to_string())
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err("Path must be relative to the workspace".to_string())
            }
            _ => {}
        }
    }

    let candidate = root_canonical.join(rel_path);

    let mut existing_ancestor = candidate.clone();
    while !existing_ancestor.exists() {
        match existing_ancestor.parent() {
            Some(parent) => existing_ancestor = parent.to_path_buf(),
            None => break,
        }
    }
    let canonical_ancestor = existing_ancestor.canonicalize().map_err(|e| e.to_string())?;
    if !path_is_within(root_canonical, &canonical_ancestor) {
        return Err("Path escapes the workspace".to_string());
    }

    Ok(candidate)
}

fn canonical_workspace_root(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let workspace = crate::project::resolve_project_workspace(app, project_id)?;
    workspace.canonicalize().map_err(|e| e.to_string())
}

// --- Pure, AppHandle-free helpers (unit-testable against a tempdir root) ---

fn list_dir_at(root_canonical: &Path, relative: &str) -> Result<Vec<FsEntry>, String> {
    let dir = resolve_within_workspace(root_canonical, relative)?;
    if !dir.is_dir() {
        return Err("Not a directory".to_string());
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden_name(&name) {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let kind = if metadata.is_dir() {
            FsEntryKind::Dir
        } else {
            FsEntryKind::File
        };
        let size = if metadata.is_file() { metadata.len() } else { 0 };
        entries.push(FsEntry { name, kind, size });
    }

    entries.sort_by(|a, b| match (a.kind, b.kind) {
        (FsEntryKind::Dir, FsEntryKind::File) => std::cmp::Ordering::Less,
        (FsEntryKind::File, FsEntryKind::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

fn read_file_at(root_canonical: &Path, relative: &str) -> Result<String, String> {
    let path = resolve_within_workspace(root_canonical, relative)?;
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Not a file".to_string());
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("File is too large to preview (max 2 MB)".to_string());
    }

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("Cannot preview a binary file".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "Cannot preview a binary file".to_string())
}

fn write_file_at(root_canonical: &Path, relative: &str, content: &str) -> Result<(), String> {
    let path = resolve_within_workspace(root_canonical, relative)?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

fn create_file_at(root_canonical: &Path, relative: &str) -> Result<(), String> {
    let path = resolve_within_workspace(root_canonical, relative)?;
    if path.exists() {
        return Err("A file or folder with that name already exists".to_string());
    }
    std::fs::File::create(&path).map_err(|e| e.to_string())?;
    Ok(())
}

fn create_dir_at(root_canonical: &Path, relative: &str) -> Result<(), String> {
    let path = resolve_within_workspace(root_canonical, relative)?;
    if path.exists() {
        return Err("A file or folder with that name already exists".to_string());
    }
    std::fs::create_dir(&path).map_err(|e| e.to_string())
}

fn rename_path_at(root_canonical: &Path, from: &str, to: &str) -> Result<(), String> {
    let from_path = resolve_within_workspace(root_canonical, from)?;
    let to_path = resolve_within_workspace(root_canonical, to)?;
    if to_path.exists() {
        return Err("A file or folder with that name already exists".to_string());
    }
    std::fs::rename(&from_path, &to_path).map_err(|e| e.to_string())
}

fn delete_path_at(root_canonical: &Path, relative: &str, force: bool) -> Result<(), String> {
    let path = resolve_within_workspace(root_canonical, relative)?;
    if !path.exists() {
        return Err("No such file or folder".to_string());
    }

    if force {
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())
        }
    } else {
        trash::delete(&path).map_err(|e| e.to_string())
    }
}

// --- Tauri commands ---

#[tauri::command]
pub fn list_dir(project_id: String, path: String, app: AppHandle) -> Result<Vec<FsEntry>, String> {
    list_dir_at(&canonical_workspace_root(&app, &project_id)?, &path)
}

#[tauri::command]
pub fn read_file(project_id: String, path: String, app: AppHandle) -> Result<String, String> {
    read_file_at(&canonical_workspace_root(&app, &project_id)?, &path)
}

#[tauri::command]
pub fn write_file(
    project_id: String,
    path: String,
    content: String,
    app: AppHandle,
) -> Result<(), String> {
    write_file_at(&canonical_workspace_root(&app, &project_id)?, &path, &content)
}

#[tauri::command]
pub fn create_file(project_id: String, path: String, app: AppHandle) -> Result<(), String> {
    create_file_at(&canonical_workspace_root(&app, &project_id)?, &path)
}

#[tauri::command]
pub fn create_dir(project_id: String, path: String, app: AppHandle) -> Result<(), String> {
    create_dir_at(&canonical_workspace_root(&app, &project_id)?, &path)
}

#[tauri::command]
pub fn rename_path(
    project_id: String,
    from: String,
    to: String,
    app: AppHandle,
) -> Result<(), String> {
    rename_path_at(&canonical_workspace_root(&app, &project_id)?, &from, &to)
}

#[tauri::command]
pub fn delete_path(
    project_id: String,
    path: String,
    force: bool,
    app: AppHandle,
) -> Result<(), String> {
    delete_path_at(&canonical_workspace_root(&app, &project_id)?, &path, force)
}

// --- Workspace file watcher ---

struct WatcherHandle {
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

/// Holds the single active workspace watcher, if any. Only one project is ever open in the UI
/// at a time, so starting a new watcher always tears down the previous one first.
#[derive(Default)]
pub struct WorkspaceWatcherState(Mutex<Option<WatcherHandle>>);

fn stop_locked(state: &WorkspaceWatcherState) {
    if let Some(handle) = state.0.lock().unwrap().take() {
        handle.stop.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn start_workspace_watcher(
    project_id: String,
    app: AppHandle,
    state: State<'_, WorkspaceWatcherState>,
) -> Result<(), String> {
    let workspace = crate::project::resolve_project_workspace(&app, &project_id)?;
    stop_locked(&state);

    let (tx, rx) = std::sync::mpsc::channel::<notify::Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let _ = tx.send(event);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&workspace, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop.clone();
    let watcher_root = workspace.clone();
    std::thread::spawn(move || {
        run_debounce_loop(rx, stop_for_thread, app, watcher_root);
    });

    *state.0.lock().unwrap() = Some(WatcherHandle {
        _watcher: watcher,
        stop,
    });
    Ok(())
}

#[tauri::command]
pub fn stop_workspace_watcher(state: State<'_, WorkspaceWatcherState>) -> Result<(), String> {
    stop_locked(&state);
    Ok(())
}

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(200);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Whether any component of `path` (relative to `root`) is a hidden entry name, so churn inside
/// `.git`/`.central` (e.g. commits made by the git engine) never triggers a tree refresh.
fn touches_hidden_entry(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .map(|rel| {
            rel.components().any(|c| {
                matches!(c, std::path::Component::Normal(name) if is_hidden_name(&name.to_string_lossy()))
            })
        })
        .unwrap_or(false)
}

fn run_debounce_loop(
    rx: std::sync::mpsc::Receiver<notify::Event>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
    root: PathBuf,
) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut last_event: Option<Instant> = None;

    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(POLL_INTERVAL) {
            Ok(event) => {
                for path in event.paths {
                    if !touches_hidden_entry(&root, &path) {
                        pending.insert(path);
                    }
                }
                if !pending.is_empty() {
                    last_event = Some(Instant::now());
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if let Some(t) = last_event {
            if t.elapsed() >= DEBOUNCE_WINDOW && !pending.is_empty() {
                let paths: Vec<String> = pending.drain().map(|p| p.display().to_string()).collect();
                let _ = app.emit("workspace-fs-changed", serde_json::json!({ "paths": paths }));
                last_event = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as TestOrdering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, TestOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "central-workspace-fs-test-{}-{}",
            std::process::id(),
            seq
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let root = temp_root();
        let result = resolve_within_workspace(&root, "../escape.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("traversal"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_traversal_nested_inside_relative_path() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let result = resolve_within_workspace(&root, "sub/../../escape.txt");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_absolute_paths() {
        let root = temp_root();
        let result = resolve_within_workspace(&root, "/etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("relative"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_windows_style_absolute_paths_where_platform_recognizes_them() {
        let root = temp_root();
        // `Component::Prefix`/`RootDir` only recognize drive-letter and `\`-rooted paths as
        // absolute on Windows; on Unix "C:/Windows/System32" has no special meaning and is a
        // perfectly ordinary (and safe) nested relative path, so it's accepted and stays within
        // root either way. This test documents that split rather than asserting rejection.
        let result = resolve_within_workspace(&root, "C:/Windows/System32");
        if cfg!(windows) {
            assert!(result.is_err());
        } else if let Ok(resolved) = &result {
            assert!(path_is_within(&root, resolved));
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_plain_relative_path() {
        let root = temp_root();
        let resolved = resolve_within_workspace(&root, "notes.txt").unwrap();
        assert_eq!(resolved, root.join("notes.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_nested_relative_path_to_new_file() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        let resolved = resolve_within_workspace(&root, "a/b/new.txt").unwrap();
        assert_eq!(resolved, root.join("a/b/new.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_relative_path_resolves_to_root() {
        let root = temp_root();
        let resolved = resolve_within_workspace(&root, "").unwrap();
        assert_eq!(resolved, root);
        let _ = std::fs::remove_dir_all(&root);
    }

    // Guards against a naive string-prefix check: "/tmp/xxx/workspace2" starts with the string
    // "/tmp/xxx/work" but is not nested inside it. `path_is_within` must use component-wise
    // comparison instead, so a symlink from inside `work` that resolves into the sibling
    // `workspace2` directory is rejected.
    #[test]
    fn rejects_prefix_collision_sibling_dir_via_symlink() {
        let base = temp_root();
        let work = base.join("work");
        let workspace2 = base.join("workspace2");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&workspace2).unwrap();
        std::fs::write(workspace2.join("secret.txt"), "top secret").unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&workspace2, work.join("escape")).unwrap();
            let root_canonical = work.canonicalize().unwrap();
            let result = resolve_within_workspace(&root_canonical, "escape/secret.txt");
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("escapes"));
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn path_is_within_rejects_string_prefix_false_positive() {
        let root = Path::new("/tmp/xxx/work");
        let sibling = Path::new("/tmp/xxx/workspace2/secret.txt");
        assert!(!path_is_within(root, sibling));
        assert!(path_is_within(root, Path::new("/tmp/xxx/work/sub/file.txt")));
    }

    #[test]
    fn list_dir_hides_git_and_central_dirs() {
        let root = temp_root();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".central")).unwrap();
        std::fs::write(root.join("visible.txt"), "hi").unwrap();

        let entries = list_dir_at(&root, "").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "visible.txt");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_dir_sorts_dirs_before_files_then_alphabetically() {
        let root = temp_root();
        std::fs::write(root.join("b.txt"), "").unwrap();
        std::fs::create_dir_all(root.join("a_dir")).unwrap();
        std::fs::write(root.join("a.txt"), "").unwrap();

        let entries = list_dir_at(&root, "").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_dir", "a.txt", "b.txt"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_file_roundtrips_written_content() {
        let root = temp_root();
        write_file_at(&root, "hello.txt", "hello world").unwrap();
        let content = read_file_at(&root, "hello.txt").unwrap();
        assert_eq!(content, "hello world");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_file_refuses_binary_content() {
        let root = temp_root();
        std::fs::write(root.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        let result = read_file_at(&root, "bin.dat");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("binary"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_file_refuses_oversized_content() {
        let root = temp_root();
        let big = vec![b'a'; (MAX_PREVIEW_BYTES + 1) as usize];
        std::fs::write(root.join("big.txt"), &big).unwrap();
        let result = read_file_at(&root, "big.txt");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too large"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_file_fails_when_already_exists() {
        let root = temp_root();
        create_file_at(&root, "x.txt").unwrap();
        let result = create_file_at(&root, "x.txt");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_dir_then_list_dir_shows_it() {
        let root = temp_root();
        create_dir_at(&root, "sub").unwrap();
        let entries = list_dir_at(&root, "").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, FsEntryKind::Dir);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_path_moves_file() {
        let root = temp_root();
        write_file_at(&root, "old.txt", "content").unwrap();
        rename_path_at(&root, "old.txt", "new.txt").unwrap();
        assert!(!root.join("old.txt").exists());
        assert_eq!(read_file_at(&root, "new.txt").unwrap(), "content");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_path_fails_when_target_exists() {
        let root = temp_root();
        write_file_at(&root, "a.txt", "a").unwrap();
        write_file_at(&root, "b.txt", "b").unwrap();
        let result = rename_path_at(&root, "a.txt", "b.txt");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_path_force_removes_file() {
        let root = temp_root();
        write_file_at(&root, "gone.txt", "bye").unwrap();
        delete_path_at(&root, "gone.txt", true).unwrap();
        assert!(!root.join("gone.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_path_force_removes_dir_recursively() {
        let root = temp_root();
        create_dir_at(&root, "sub").unwrap();
        write_file_at(&root, "sub/file.txt", "x").unwrap();
        delete_path_at(&root, "sub", true).unwrap();
        assert!(!root.join("sub").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_path_rejects_missing_entry() {
        let root = temp_root();
        let result = delete_path_at(&root, "missing.txt", true);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn touches_hidden_entry_detects_git_and_central() {
        let root = PathBuf::from("/tmp/proj");
        assert!(touches_hidden_entry(&root, &root.join(".git/HEAD")));
        assert!(touches_hidden_entry(&root, &root.join(".central/worktrees/x")));
        assert!(!touches_hidden_entry(&root, &root.join("src/main.rs")));
    }
}
