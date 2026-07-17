use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Entry in the top-level projects manifest. Deliberately excludes the graph itself so the
/// Home page can list/sort projects without deserializing every project's nodes/edges.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_modified_at: u64,
    pub path: String,
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn sanitize_id(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect()
}

fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|dir| dir.join("projects")).map_err(|e| e.to_string())
}

// --- Pure, AppHandle-free helpers (unit-testable against a tempdir root) ---

fn manifest_path_at(root: &Path) -> PathBuf {
    root.join("index.json")
}

fn project_dir_at(root: &Path, id: &str) -> PathBuf {
    root.join(sanitize_id(id))
}

fn graph_path_at(root: &Path, id: &str) -> PathBuf {
    project_dir_at(root, id).join("graph.json")
}

fn read_manifest_at(root: &Path) -> Result<Vec<ProjectMeta>, String> {
    let path = manifest_path_at(root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_manifest_at(root: &Path, projects: &[ProjectMeta]) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
    std::fs::write(manifest_path_at(root), raw).map_err(|e| e.to_string())
}

fn create_project_at(root: &Path, name: &str) -> Result<ProjectMeta, String> {
    let id = format!("{}-{}", sanitize_id(&name.to_lowercase()), now_millis());
    let dir = project_dir_at(root, &id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let now = now_millis();
    let meta = ProjectMeta {
        id,
        name: name.to_string(),
        created_at: now,
        last_modified_at: now,
        path: dir.display().to_string(),
    };

    let mut projects = read_manifest_at(root)?;
    projects.push(meta.clone());
    write_manifest_at(root, &projects)?;

    Ok(meta)
}

fn save_project_graph_at(root: &Path, project_id: &str, graph: &serde_json::Value) -> Result<(), String> {
    let dir = project_dir_at(root, project_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string(graph).map_err(|e| e.to_string())?;
    std::fs::write(graph_path_at(root, project_id), raw).map_err(|e| e.to_string())?;

    let mut projects = read_manifest_at(root)?;
    if let Some(p) = projects.iter_mut().find(|p| p.id == project_id) {
        p.last_modified_at = now_millis();
        write_manifest_at(root, &projects)?;
    }

    Ok(())
}

fn load_project_graph_at(root: &Path, project_id: &str) -> Result<Option<serde_json::Value>, String> {
    let path = graph_path_at(root, project_id);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

// --- Tauri commands ---

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    read_manifest_at(&projects_root(&app)?)
}

#[tauri::command]
pub fn create_project(name: String, app: AppHandle) -> Result<ProjectMeta, String> {
    create_project_at(&projects_root(&app)?, &name)
}

#[tauri::command]
pub fn save_project_graph(project_id: String, graph: serde_json::Value, app: AppHandle) -> Result<(), String> {
    save_project_graph_at(&projects_root(&app)?, &project_id, &graph)
}

#[tauri::command]
pub fn load_project_graph(project_id: String, app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    load_project_graph_at(&projects_root(&app)?, &project_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("central-project-test-{}-{}", std::process::id(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_project_adds_entry_to_manifest() {
        let root = temp_root();
        let meta = create_project_at(&root, "My Project").unwrap();

        assert_eq!(meta.name, "My Project");
        assert!(Path::new(&meta.path).exists());

        let manifest = read_manifest_at(&root).unwrap();
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].id, meta.id);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn save_and_load_graph_roundtrips() {
        let root = temp_root();
        let meta = create_project_at(&root, "Roundtrip").unwrap();

        let graph = serde_json::json!({
            "nodes": [{ "id": "n1" }],
            "edges": [],
            "viewport": { "x": 0, "y": 0, "zoom": 1 },
        });
        save_project_graph_at(&root, &meta.id, &graph).unwrap();

        let loaded = load_project_graph_at(&root, &meta.id).unwrap();
        assert_eq!(loaded, Some(graph));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn save_graph_updates_manifest_last_modified_at() {
        let root = temp_root();
        let meta = create_project_at(&root, "Timestamps").unwrap();

        std::thread::sleep(std::time::Duration::from_millis(5));
        save_project_graph_at(&root, &meta.id, &serde_json::json!({})).unwrap();

        let manifest = read_manifest_at(&root).unwrap();
        let updated = manifest.iter().find(|p| p.id == meta.id).unwrap();
        assert!(updated.last_modified_at >= meta.last_modified_at);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_graph_returns_none_when_missing() {
        let root = temp_root();
        let result = load_project_graph_at(&root, "does-not-exist").unwrap();
        assert_eq!(result, None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_projects_returns_empty_when_manifest_missing() {
        let root = temp_root();
        let result = read_manifest_at(&root).unwrap();
        assert!(result.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }
}
