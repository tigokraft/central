use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{Repository, Signature};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Whether a project's workspace folder was created by Central ("managed") or points at a
/// pre-existing folder the user chose ("linked").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    #[default]
    Managed,
    Linked,
}

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
    /// Real on-disk folder containing the project's files. Empty for manifests written before
    /// this field existed; `ensure_project_workspace` migrates those lazily on open.
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub workspace_kind: WorkspaceKind,
}

/// Persisted app-wide settings, stored alongside the projects manifest in the app data dir.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default)]
    default_projects_location: Option<String>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("projects"))
        .map_err(|e| e.to_string())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

// --- Pure, AppHandle-free helpers (unit-testable against a tempdir root) ---

fn manifest_path_at(root: &Path) -> PathBuf {
    root.join("index.json")
}

fn project_dir_at(root: &Path, id: &str) -> PathBuf {
    root.join(sanitize_id(id))
}

/// Path of the legacy single-graph file a pre-pipelines project stored its canvas at.
/// Only read during migration (see `ensure_pipelines_at`); never written to anymore.
fn legacy_graph_path_at(root: &Path, id: &str) -> PathBuf {
    project_dir_at(root, id).join("graph.json")
}

fn settings_path_at(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

fn read_app_settings_at(data_dir: &Path) -> AppSettings {
    let path = settings_path_at(data_dir);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_app_settings_at(data_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(settings_path_at(data_dir), raw).map_err(|e| e.to_string())
}

/// Where managed workspaces land when the user hasn't overridden the location: `<data_dir>/
/// settings.json`'s `defaultProjectsLocation` if set, otherwise `<documents_dir>/Central`.
fn resolve_default_projects_location(data_dir: &Path, documents_dir: &Path) -> PathBuf {
    match read_app_settings_at(data_dir).default_projects_location {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => documents_dir.join("Central"),
    }
}

/// Strips characters that are invalid in a path segment on Windows/macOS/Linux, so a project
/// name can be used directly as a folder name on any OS.
fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        "project".to_string()
    } else {
        cleaned
    }
}

/// Appends " (2)", " (3)", ... until `base/<name>` doesn't already exist.
fn unique_dir_under(base: &Path, name: &str) -> PathBuf {
    let sanitized = sanitize_folder_name(name);
    let mut candidate = base.join(&sanitized);
    let mut n = 2;
    while candidate.exists() {
        candidate = base.join(format!("{} ({})", sanitized, n));
        n += 1;
    }
    candidate
}

fn init_git_repo_with_initial_commit(dir: &Path) -> Result<(), String> {
    let repo = Repository::init(dir).map_err(|e| e.to_string())?;
    let tree_oid = repo
        .index()
        .and_then(|mut index| index.write_tree())
        .map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let sig = Signature::now("Central", "central@local").map_err(|e| e.to_string())?;
    repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Creates a fresh, git-initialized folder for a managed workspace under `base`, named after
/// the project (de-duplicated if a folder with that name already exists).
fn create_managed_workspace_at(base: &Path, name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let dir = unique_dir_under(base, name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    init_git_repo_with_initial_commit(&dir)?;
    Ok(dir)
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

fn create_project_at(
    root: &Path,
    name: &str,
    workspace_path: &Path,
    workspace_kind: WorkspaceKind,
) -> Result<ProjectMeta, String> {
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
        workspace_path: workspace_path.display().to_string(),
        workspace_kind,
    };

    let mut projects = read_manifest_at(root)?;
    projects.push(meta.clone());
    write_manifest_at(root, &projects)?;

    Ok(meta)
}

/// Lazily gives a pre-workspace-era project (empty `workspacePath`) a managed workspace the
/// first time it's opened, so old manifests keep working without a manual migration step.
fn ensure_workspace_at(
    root: &Path,
    project_id: &str,
    default_base: &Path,
) -> Result<ProjectMeta, String> {
    let mut projects = read_manifest_at(root)?;
    let idx = projects
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;

    if projects[idx].workspace_path.is_empty() {
        let workspace = create_managed_workspace_at(default_base, &projects[idx].name)?;
        projects[idx].workspace_path = workspace.display().to_string();
        projects[idx].workspace_kind = WorkspaceKind::Managed;
        write_manifest_at(root, &projects)?;
    }

    Ok(projects[idx].clone())
}

/// Entry in a project's pipelines manifest. Deliberately excludes the graph itself, mirroring
/// `ProjectMeta`, so the tab bar can list/sort pipelines without deserializing every graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineMeta {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_modified_at: u64,
}

fn default_graph_json() -> serde_json::Value {
    serde_json::json!({ "nodes": [], "edges": [], "viewport": { "x": 0, "y": 0, "zoom": 1 } })
}

// Guarantees a unique pipeline id even when two pipelines with the same name are created
// within the same millisecond (e.g. duplicating a pipeline right after ensure_pipelines_at
// seeds "Main" — both would otherwise derive "main-<same timestamp>").
static PIPELINE_ID_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_pipeline_id(name: &str) -> String {
    let seq = PIPELINE_ID_SEQ.fetch_add(1, Ordering::SeqCst);
    format!(
        "{}-{}-{}",
        sanitize_id(&name.to_lowercase()),
        now_millis(),
        seq
    )
}

fn pipelines_dir_at(root: &Path, project_id: &str) -> PathBuf {
    project_dir_at(root, project_id).join("pipelines")
}

fn pipelines_manifest_path_at(root: &Path, project_id: &str) -> PathBuf {
    pipelines_dir_at(root, project_id).join("index.json")
}

fn pipeline_graph_path_at(root: &Path, project_id: &str, pipeline_id: &str) -> PathBuf {
    pipelines_dir_at(root, project_id).join(format!("{}.json", sanitize_id(pipeline_id)))
}

fn read_pipelines_manifest_at(root: &Path, project_id: &str) -> Result<Vec<PipelineMeta>, String> {
    let path = pipelines_manifest_path_at(root, project_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_pipelines_manifest_at(
    root: &Path,
    project_id: &str,
    pipelines: &[PipelineMeta],
) -> Result<(), String> {
    std::fs::create_dir_all(pipelines_dir_at(root, project_id)).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(pipelines).map_err(|e| e.to_string())?;
    std::fs::write(pipelines_manifest_path_at(root, project_id), raw).map_err(|e| e.to_string())
}

/// Bumps a project's `lastModifiedAt` in the top-level projects manifest, e.g. when one of its
/// pipeline graphs is saved. No-ops if the project id isn't found.
fn touch_project_at(root: &Path, project_id: &str) -> Result<(), String> {
    let mut projects = read_manifest_at(root)?;
    if let Some(p) = projects.iter_mut().find(|p| p.id == project_id) {
        p.last_modified_at = now_millis();
        write_manifest_at(root, &projects)?;
    }
    Ok(())
}

/// Returns a project's pipelines manifest, creating it on first access. A project with no
/// manifest yet either has a legacy single `graph.json` (pre-pipelines project — moved into a
/// "Main" pipeline) or is brand new (given a fresh empty "Main" pipeline). Idempotent: once the
/// manifest exists, it's just read back as-is.
fn ensure_pipelines_at(root: &Path, project_id: &str) -> Result<Vec<PipelineMeta>, String> {
    let manifest_path = pipelines_manifest_path_at(root, project_id);
    if manifest_path.exists() {
        return read_pipelines_manifest_at(root, project_id);
    }

    let now = now_millis();
    let pipeline_id = new_pipeline_id("main");
    let meta = PipelineMeta {
        id: pipeline_id.clone(),
        name: "Main".to_string(),
        created_at: now,
        last_modified_at: now,
    };

    let dest = pipeline_graph_path_at(root, project_id, &pipeline_id);
    std::fs::create_dir_all(pipelines_dir_at(root, project_id)).map_err(|e| e.to_string())?;

    let legacy_path = legacy_graph_path_at(root, project_id);
    if legacy_path.exists() {
        std::fs::rename(&legacy_path, &dest).map_err(|e| e.to_string())?;
    } else {
        let raw = serde_json::to_string(&default_graph_json()).map_err(|e| e.to_string())?;
        std::fs::write(&dest, raw).map_err(|e| e.to_string())?;
    }

    let manifest = vec![meta];
    write_pipelines_manifest_at(root, project_id, &manifest)?;
    Ok(manifest)
}

fn create_pipeline_at(root: &Path, project_id: &str, name: &str) -> Result<PipelineMeta, String> {
    let mut pipelines = ensure_pipelines_at(root, project_id)?;

    let now = now_millis();
    let meta = PipelineMeta {
        id: new_pipeline_id(name),
        name: name.to_string(),
        created_at: now,
        last_modified_at: now,
    };

    let raw = serde_json::to_string(&default_graph_json()).map_err(|e| e.to_string())?;
    std::fs::write(pipeline_graph_path_at(root, project_id, &meta.id), raw)
        .map_err(|e| e.to_string())?;

    pipelines.push(meta.clone());
    write_pipelines_manifest_at(root, project_id, &pipelines)?;
    Ok(meta)
}

fn rename_pipeline_at(
    root: &Path,
    project_id: &str,
    pipeline_id: &str,
    name: &str,
) -> Result<(), String> {
    let mut pipelines = ensure_pipelines_at(root, project_id)?;
    let entry = pipelines
        .iter_mut()
        .find(|p| p.id == pipeline_id)
        .ok_or_else(|| format!("Pipeline '{}' not found", pipeline_id))?;
    entry.name = name.to_string();
    entry.last_modified_at = now_millis();
    write_pipelines_manifest_at(root, project_id, &pipelines)
}

fn duplicate_pipeline_at(
    root: &Path,
    project_id: &str,
    pipeline_id: &str,
) -> Result<PipelineMeta, String> {
    let mut pipelines = ensure_pipelines_at(root, project_id)?;
    let source = pipelines
        .iter()
        .find(|p| p.id == pipeline_id)
        .ok_or_else(|| format!("Pipeline '{}' not found", pipeline_id))?
        .clone();

    let now = now_millis();
    let meta = PipelineMeta {
        id: new_pipeline_id(&source.name),
        name: format!("{} copy", source.name),
        created_at: now,
        last_modified_at: now,
    };

    let source_path = pipeline_graph_path_at(root, project_id, &source.id);
    let raw = if source_path.exists() {
        std::fs::read_to_string(&source_path).map_err(|e| e.to_string())?
    } else {
        serde_json::to_string(&default_graph_json()).map_err(|e| e.to_string())?
    };
    std::fs::write(pipeline_graph_path_at(root, project_id, &meta.id), raw)
        .map_err(|e| e.to_string())?;

    pipelines.push(meta.clone());
    write_pipelines_manifest_at(root, project_id, &pipelines)?;
    Ok(meta)
}

fn delete_pipeline_at(root: &Path, project_id: &str, pipeline_id: &str) -> Result<(), String> {
    let mut pipelines = ensure_pipelines_at(root, project_id)?;
    if pipelines.len() <= 1 {
        return Err("A project must keep at least one pipeline".to_string());
    }
    let idx = pipelines
        .iter()
        .position(|p| p.id == pipeline_id)
        .ok_or_else(|| format!("Pipeline '{}' not found", pipeline_id))?;
    pipelines.remove(idx);
    write_pipelines_manifest_at(root, project_id, &pipelines)?;

    let path = pipeline_graph_path_at(root, project_id, pipeline_id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn save_pipeline_graph_at(
    root: &Path,
    project_id: &str,
    pipeline_id: &str,
    graph: &serde_json::Value,
) -> Result<(), String> {
    let mut pipelines = ensure_pipelines_at(root, project_id)?;
    let entry = pipelines
        .iter_mut()
        .find(|p| p.id == pipeline_id)
        .ok_or_else(|| format!("Pipeline '{}' not found", pipeline_id))?;
    entry.last_modified_at = now_millis();
    write_pipelines_manifest_at(root, project_id, &pipelines)?;

    let raw = serde_json::to_string(graph).map_err(|e| e.to_string())?;
    std::fs::write(pipeline_graph_path_at(root, project_id, pipeline_id), raw)
        .map_err(|e| e.to_string())?;

    touch_project_at(root, project_id)
}

fn load_pipeline_graph_at(
    root: &Path,
    project_id: &str,
    pipeline_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let path = pipeline_graph_path_at(root, project_id, pipeline_id);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Entry in a project's workbench manifest: persists everything needed to restore a session's
/// card layout on reopen (label, agent, git binding) but never the live PTY/xterm state,
/// which is transient and only meaningful while the app process is running.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchSessionMeta {
    pub id: String,
    pub label: String,
    pub agent_id: Option<String>,
    pub binding: crate::git_engine::WorkbenchBinding,
}

fn workbench_path_at(root: &Path, project_id: &str) -> PathBuf {
    project_dir_at(root, project_id).join("workbench.json")
}

fn read_workbench_sessions_at(
    root: &Path,
    project_id: &str,
) -> Result<Vec<WorkbenchSessionMeta>, String> {
    let path = workbench_path_at(root, project_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_workbench_sessions_at(
    root: &Path,
    project_id: &str,
    sessions: &[WorkbenchSessionMeta],
) -> Result<(), String> {
    let dir = project_dir_at(root, project_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(sessions).map_err(|e| e.to_string())?;
    std::fs::write(workbench_path_at(root, project_id), raw).map_err(|e| e.to_string())
}

/// Per-project settings for the multi-agent task orchestrator's runs. `test_command` is run by
/// the integrator after merging each task's branch onto `central/staging`; empty means skipped.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationSettings {
    #[serde(default)]
    pub test_command: String,
}

fn orchestration_settings_path_at(root: &Path, project_id: &str) -> PathBuf {
    project_dir_at(root, project_id).join("orchestration.json")
}

fn read_orchestration_settings_at(
    root: &Path,
    project_id: &str,
) -> Result<OrchestrationSettings, String> {
    let path = orchestration_settings_path_at(root, project_id);
    if !path.exists() {
        return Ok(OrchestrationSettings::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_orchestration_settings_at(
    root: &Path,
    project_id: &str,
    settings: &OrchestrationSettings,
) -> Result<(), String> {
    let dir = project_dir_at(root, project_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(orchestration_settings_path_at(root, project_id), raw).map_err(|e| e.to_string())
}

fn default_projects_base(app: &AppHandle) -> Result<PathBuf, String> {
    let documents_dir = app.path().document_dir().map_err(|e| e.to_string())?;
    let data_dir = app_data_dir(app)?;
    Ok(resolve_default_projects_location(&data_dir, &documents_dir))
}

/// Looks up a project's on-disk workspace folder from the manifest. Git-engine entry points
/// resolve through this rather than trusting a path string handed to them by the frontend, so
/// a caller can only ever operate on a workspace that a real project manifest entry vouches for.
fn workspace_path_for(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    let projects = read_manifest_at(root)?;
    let meta = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    if meta.workspace_path.is_empty() {
        return Err(format!(
            "Project '{}' has no workspace yet; open it once to migrate",
            project_id
        ));
    }
    Ok(PathBuf::from(&meta.workspace_path))
}

/// AppHandle-bound counterpart of `workspace_path_for`, for git-engine and graph-runner
/// commands that only receive a `project_id` from the frontend.
pub fn resolve_project_workspace(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    workspace_path_for(&projects_root(app)?, project_id)
}

// --- Tauri commands ---

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    read_manifest_at(&projects_root(&app)?)
}

#[tauri::command]
pub fn create_project(
    name: String,
    workspace_kind: String,
    linked_path: Option<String>,
    app: AppHandle,
) -> Result<ProjectMeta, String> {
    let (workspace_path, kind) = match workspace_kind.as_str() {
        "linked" => {
            let path = linked_path.ok_or("A folder must be chosen for a linked workspace")?;
            (PathBuf::from(path), WorkspaceKind::Linked)
        }
        _ => {
            let base = default_projects_base(&app)?;
            (
                create_managed_workspace_at(&base, &name)?,
                WorkspaceKind::Managed,
            )
        }
    };

    create_project_at(&projects_root(&app)?, &name, &workspace_path, kind)
}

#[tauri::command]
pub fn ensure_project_workspace(project_id: String, app: AppHandle) -> Result<ProjectMeta, String> {
    let base = default_projects_base(&app)?;
    ensure_workspace_at(&projects_root(&app)?, &project_id, &base)
}

#[tauri::command]
pub fn get_default_projects_location(app: AppHandle) -> Result<String, String> {
    Ok(default_projects_base(&app)?.display().to_string())
}

#[tauri::command]
pub fn set_default_projects_location(path: String, app: AppHandle) -> Result<(), String> {
    write_app_settings_at(
        &app_data_dir(&app)?,
        &AppSettings {
            default_projects_location: Some(path),
        },
    )
}

#[tauri::command]
pub fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[tauri::command]
pub fn list_pipelines(project_id: String, app: AppHandle) -> Result<Vec<PipelineMeta>, String> {
    ensure_pipelines_at(&projects_root(&app)?, &project_id)
}

#[tauri::command]
pub fn create_pipeline(
    project_id: String,
    name: String,
    app: AppHandle,
) -> Result<PipelineMeta, String> {
    create_pipeline_at(&projects_root(&app)?, &project_id, &name)
}

#[tauri::command]
pub fn rename_pipeline(
    project_id: String,
    pipeline_id: String,
    name: String,
    app: AppHandle,
) -> Result<(), String> {
    rename_pipeline_at(&projects_root(&app)?, &project_id, &pipeline_id, &name)
}

#[tauri::command]
pub fn duplicate_pipeline(
    project_id: String,
    pipeline_id: String,
    app: AppHandle,
) -> Result<PipelineMeta, String> {
    duplicate_pipeline_at(&projects_root(&app)?, &project_id, &pipeline_id)
}

#[tauri::command]
pub fn delete_pipeline(
    project_id: String,
    pipeline_id: String,
    app: AppHandle,
) -> Result<(), String> {
    delete_pipeline_at(&projects_root(&app)?, &project_id, &pipeline_id)
}

#[tauri::command]
pub fn save_pipeline_graph(
    project_id: String,
    pipeline_id: String,
    graph: serde_json::Value,
    app: AppHandle,
) -> Result<(), String> {
    save_pipeline_graph_at(&projects_root(&app)?, &project_id, &pipeline_id, &graph)
}

#[tauri::command]
pub fn load_pipeline_graph(
    project_id: String,
    pipeline_id: String,
    app: AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    load_pipeline_graph_at(&projects_root(&app)?, &project_id, &pipeline_id)
}

#[tauri::command]
pub fn list_workbench_sessions(
    project_id: String,
    app: AppHandle,
) -> Result<Vec<WorkbenchSessionMeta>, String> {
    read_workbench_sessions_at(&projects_root(&app)?, &project_id)
}

#[tauri::command]
pub fn save_workbench_sessions(
    project_id: String,
    sessions: Vec<WorkbenchSessionMeta>,
    app: AppHandle,
) -> Result<(), String> {
    write_workbench_sessions_at(&projects_root(&app)?, &project_id, &sessions)
}

#[tauri::command]
pub fn get_orchestration_settings(
    project_id: String,
    app: AppHandle,
) -> Result<OrchestrationSettings, String> {
    read_orchestration_settings_at(&projects_root(&app)?, &project_id)
}

#[tauri::command]
pub fn save_orchestration_settings(
    project_id: String,
    settings: OrchestrationSettings,
    app: AppHandle,
) -> Result<(), String> {
    write_orchestration_settings_at(&projects_root(&app)?, &project_id, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "central-project-test-{}-{}",
            std::process::id(),
            seq
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // Manifest root and workspace base are deliberately separate tempdirs in these tests,
    // mirroring how the app data dir and the on-disk workspace location differ in production.
    fn create_test_project(root: &Path, name: &str) -> ProjectMeta {
        let base = temp_root();
        let workspace = create_managed_workspace_at(&base, name).unwrap();
        create_project_at(root, name, &workspace, WorkspaceKind::Managed).unwrap()
    }

    #[test]
    fn create_project_adds_entry_to_manifest() {
        let root = temp_root();
        let meta = create_test_project(&root, "My Project");

        assert_eq!(meta.name, "My Project");
        assert!(Path::new(&meta.path).exists());
        assert!(Path::new(&meta.workspace_path).exists());
        assert_eq!(meta.workspace_kind, WorkspaceKind::Managed);

        let manifest = read_manifest_at(&root).unwrap();
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].id, meta.id);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn save_and_load_pipeline_graph_roundtrips() {
        let root = temp_root();
        let meta = create_test_project(&root, "Roundtrip");
        let pipeline = ensure_pipelines_at(&root, &meta.id).unwrap().remove(0);

        let graph = serde_json::json!({
            "nodes": [{ "id": "n1" }],
            "edges": [],
            "viewport": { "x": 0, "y": 0, "zoom": 1 },
        });
        save_pipeline_graph_at(&root, &meta.id, &pipeline.id, &graph).unwrap();

        let loaded = load_pipeline_graph_at(&root, &meta.id, &pipeline.id).unwrap();
        assert_eq!(loaded, Some(graph));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn save_pipeline_graph_updates_pipeline_and_project_last_modified_at() {
        let root = temp_root();
        let meta = create_test_project(&root, "Timestamps");
        let pipeline = ensure_pipelines_at(&root, &meta.id).unwrap().remove(0);

        std::thread::sleep(std::time::Duration::from_millis(5));
        save_pipeline_graph_at(&root, &meta.id, &pipeline.id, &serde_json::json!({})).unwrap();

        let project_manifest = read_manifest_at(&root).unwrap();
        let updated_project = project_manifest.iter().find(|p| p.id == meta.id).unwrap();
        assert!(updated_project.last_modified_at >= meta.last_modified_at);

        let pipelines = read_pipelines_manifest_at(&root, &meta.id).unwrap();
        let updated_pipeline = pipelines.iter().find(|p| p.id == pipeline.id).unwrap();
        assert!(updated_pipeline.last_modified_at >= pipeline.last_modified_at);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn load_pipeline_graph_returns_none_when_missing() {
        let root = temp_root();
        let result = load_pipeline_graph_at(&root, "does-not-exist", "also-missing").unwrap();
        assert_eq!(result, None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_pipelines_migrates_legacy_graph_into_main_pipeline() {
        let root = temp_root();
        let meta = create_test_project(&root, "Legacy Graph");

        let graph = serde_json::json!({
            "nodes": [{ "id": "n1" }],
            "edges": [],
            "viewport": { "x": 0, "y": 0, "zoom": 1 },
        });
        std::fs::write(legacy_graph_path_at(&root, &meta.id), graph.to_string()).unwrap();

        let pipelines = ensure_pipelines_at(&root, &meta.id).unwrap();
        assert_eq!(pipelines.len(), 1);
        assert_eq!(pipelines[0].name, "Main");
        assert!(!legacy_graph_path_at(&root, &meta.id).exists());

        let loaded = load_pipeline_graph_at(&root, &meta.id, &pipelines[0].id).unwrap();
        assert_eq!(loaded, Some(graph));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn ensure_pipelines_creates_empty_main_pipeline_for_brand_new_project() {
        let root = temp_root();
        let meta = create_test_project(&root, "Brand New");

        let pipelines = ensure_pipelines_at(&root, &meta.id).unwrap();
        assert_eq!(pipelines.len(), 1);
        assert_eq!(pipelines[0].name, "Main");

        let loaded = load_pipeline_graph_at(&root, &meta.id, &pipelines[0].id).unwrap();
        assert_eq!(loaded, Some(default_graph_json()));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn ensure_pipelines_is_idempotent() {
        let root = temp_root();
        let meta = create_test_project(&root, "Idempotent");

        let first = ensure_pipelines_at(&root, &meta.id).unwrap();
        let second = ensure_pipelines_at(&root, &meta.id).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, second[0].id);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn create_pipeline_adds_entry_with_empty_graph() {
        let root = temp_root();
        let meta = create_test_project(&root, "Create Pipeline");

        let created = create_pipeline_at(&root, &meta.id, "Second").unwrap();
        let pipelines = read_pipelines_manifest_at(&root, &meta.id).unwrap();
        assert_eq!(pipelines.len(), 2);
        assert!(pipelines
            .iter()
            .any(|p| p.id == created.id && p.name == "Second"));

        let loaded = load_pipeline_graph_at(&root, &meta.id, &created.id).unwrap();
        assert_eq!(loaded, Some(default_graph_json()));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn rename_pipeline_updates_name() {
        let root = temp_root();
        let meta = create_test_project(&root, "Rename Pipeline");
        let pipeline = ensure_pipelines_at(&root, &meta.id).unwrap().remove(0);

        rename_pipeline_at(&root, &meta.id, &pipeline.id, "Renamed").unwrap();

        let pipelines = read_pipelines_manifest_at(&root, &meta.id).unwrap();
        assert_eq!(pipelines[0].name, "Renamed");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn duplicate_pipeline_copies_graph_under_new_id() {
        let root = temp_root();
        let meta = create_test_project(&root, "Duplicate Pipeline");
        let pipeline = ensure_pipelines_at(&root, &meta.id).unwrap().remove(0);

        let graph = serde_json::json!({ "nodes": [{ "id": "n1" }], "edges": [], "viewport": { "x": 0, "y": 0, "zoom": 1 } });
        save_pipeline_graph_at(&root, &meta.id, &pipeline.id, &graph).unwrap();

        let duplicated = duplicate_pipeline_at(&root, &meta.id, &pipeline.id).unwrap();
        assert_ne!(duplicated.id, pipeline.id);
        assert_eq!(duplicated.name, "Main copy");

        let loaded = load_pipeline_graph_at(&root, &meta.id, &duplicated.id).unwrap();
        assert_eq!(loaded, Some(graph));

        let pipelines = read_pipelines_manifest_at(&root, &meta.id).unwrap();
        assert_eq!(pipelines.len(), 2);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn delete_pipeline_removes_entry_and_graph_file() {
        let root = temp_root();
        let meta = create_test_project(&root, "Delete Pipeline");
        let first = ensure_pipelines_at(&root, &meta.id).unwrap().remove(0);
        let second = create_pipeline_at(&root, &meta.id, "Second").unwrap();

        delete_pipeline_at(&root, &meta.id, &second.id).unwrap();

        let pipelines = read_pipelines_manifest_at(&root, &meta.id).unwrap();
        assert_eq!(pipelines.len(), 1);
        assert_eq!(pipelines[0].id, first.id);
        assert!(!pipeline_graph_path_at(&root, &meta.id, &second.id).exists());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn delete_pipeline_rejects_removing_last_remaining_pipeline() {
        let root = temp_root();
        let meta = create_test_project(&root, "Delete Last Pipeline");
        let only = ensure_pipelines_at(&root, &meta.id).unwrap().remove(0);

        let result = delete_pipeline_at(&root, &meta.id, &only.id);
        assert!(result.is_err());

        let pipelines = read_pipelines_manifest_at(&root, &meta.id).unwrap();
        assert_eq!(pipelines.len(), 1);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn list_projects_returns_empty_when_manifest_missing() {
        let root = temp_root();
        let result = read_manifest_at(&root).unwrap();
        assert!(result.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_without_workspace_fields_deserializes_with_defaults() {
        let root = temp_root();
        let raw = serde_json::json!([{
            "id": "legacy-1",
            "name": "Legacy Project",
            "createdAt": 1,
            "lastModifiedAt": 1,
            "path": "/some/path",
        }]);
        std::fs::write(manifest_path_at(&root), raw.to_string()).unwrap();

        let manifest = read_manifest_at(&root).unwrap();
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].workspace_path, "");
        assert_eq!(manifest[0].workspace_kind, WorkspaceKind::Managed);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_managed_workspace_initializes_git_repo_with_initial_commit() {
        let base = temp_root();
        let workspace = create_managed_workspace_at(&base, "Git Project").unwrap();

        assert!(workspace.exists());
        let repo = Repository::open(&workspace).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message(), Some("Initial commit"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unique_dir_under_dedupes_existing_folder_names() {
        let base = temp_root();
        std::fs::create_dir_all(base.join("Dup")).unwrap();

        let deduped = unique_dir_under(&base, "Dup");
        assert_eq!(deduped, base.join("Dup (2)"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ensure_workspace_at_migrates_project_missing_workspace_path() {
        let root = temp_root();
        let base = temp_root();
        let meta =
            create_project_at(&root, "Legacy", Path::new(""), WorkspaceKind::Managed).unwrap();
        assert!(meta.workspace_path.is_empty());

        let migrated = ensure_workspace_at(&root, &meta.id, &base).unwrap();
        assert!(!migrated.workspace_path.is_empty());
        assert!(Path::new(&migrated.workspace_path).exists());
        assert_eq!(migrated.workspace_kind, WorkspaceKind::Managed);

        let manifest = read_manifest_at(&root).unwrap();
        assert_eq!(manifest[0].workspace_path, migrated.workspace_path);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&migrated.workspace_path);
    }

    #[test]
    fn ensure_workspace_at_is_noop_when_workspace_already_set() {
        let root = temp_root();
        let base = temp_root();
        let meta = create_test_project(&root, "Already Has Workspace");

        let result = ensure_workspace_at(&root, &meta.id, &base).unwrap();
        assert_eq!(result.workspace_path, meta.workspace_path);

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn resolve_default_projects_location_falls_back_to_documents_dir() {
        let data_dir = temp_root();
        let documents_dir = PathBuf::from("/tmp/fake-documents");

        let resolved = resolve_default_projects_location(&data_dir, &documents_dir);
        assert_eq!(resolved, documents_dir.join("Central"));

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn workspace_path_for_returns_project_workspace() {
        let root = temp_root();
        let meta = create_test_project(&root, "Lookup Me");

        let resolved = workspace_path_for(&root, &meta.id).unwrap();
        assert_eq!(resolved, PathBuf::from(&meta.workspace_path));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn workspace_path_for_rejects_unknown_project_id() {
        let root = temp_root();
        let result = workspace_path_for(&root, "does-not-exist");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn workspace_path_for_rejects_project_without_workspace() {
        let root = temp_root();
        let meta =
            create_project_at(&root, "Legacy", Path::new(""), WorkspaceKind::Managed).unwrap();

        let result = workspace_path_for(&root, &meta.id);
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_default_projects_location_prefers_settings_override() {
        let data_dir = temp_root();
        let documents_dir = PathBuf::from("/tmp/fake-documents");
        write_app_settings_at(
            &data_dir,
            &AppSettings {
                default_projects_location: Some("/custom/location".to_string()),
            },
        )
        .unwrap();

        let resolved = resolve_default_projects_location(&data_dir, &documents_dir);
        assert_eq!(resolved, PathBuf::from("/custom/location"));

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn list_workbench_sessions_returns_empty_when_missing() {
        let root = temp_root();
        let result = read_workbench_sessions_at(&root, "does-not-exist").unwrap();
        assert!(result.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn save_and_load_workbench_sessions_roundtrips() {
        use crate::git_engine::WorkbenchBinding;

        let root = temp_root();
        let meta = create_test_project(&root, "Workbench Roundtrip");

        let sessions = vec![
            WorkbenchSessionMeta {
                id: "sess-1".to_string(),
                label: "Coder".to_string(),
                agent_id: Some("claude-code".to_string()),
                binding: WorkbenchBinding::Main,
            },
            WorkbenchSessionMeta {
                id: "sess-2".to_string(),
                label: "Reviewer".to_string(),
                agent_id: None,
                binding: WorkbenchBinding::New {
                    branch: "review-branch".to_string(),
                },
            },
        ];
        write_workbench_sessions_at(&root, &meta.id, &sessions).unwrap();

        let loaded = read_workbench_sessions_at(&root, &meta.id).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "sess-1");
        assert_eq!(
            loaded[1].binding,
            WorkbenchBinding::New {
                branch: "review-branch".to_string()
            }
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn get_orchestration_settings_defaults_to_empty_test_command() {
        let root = temp_root();
        let meta = create_test_project(&root, "Orchestration Defaults");

        let settings = read_orchestration_settings_at(&root, &meta.id).unwrap();
        assert_eq!(settings.test_command, "");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }

    #[test]
    fn save_and_load_orchestration_settings_roundtrips() {
        let root = temp_root();
        let meta = create_test_project(&root, "Orchestration Roundtrip");

        write_orchestration_settings_at(
            &root,
            &meta.id,
            &OrchestrationSettings {
                test_command: "pnpm test".to_string(),
            },
        )
        .unwrap();

        let loaded = read_orchestration_settings_at(&root, &meta.id).unwrap();
        assert_eq!(loaded.test_command, "pnpm test");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&meta.workspace_path);
    }
}
