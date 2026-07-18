mod ephemeral;
mod git_engine;
mod graph_runner;
mod mcp;
pub mod memory;
mod project;
mod pty_manager;
mod workspace_fs;

use std::path::PathBuf;
use std::sync::Mutex;

/// Tracks the directory of whichever project is currently open in the UI. Every
/// cwd-dependent backend call (terminals, git diff, memory records) resolves through
/// this instead of the process's own working directory, so multiple projects can't
/// bleed into each other. `None` means no project has been opened yet.
#[derive(Default)]
pub struct ProjectState(pub Mutex<Option<PathBuf>>);

#[tauri::command]
fn set_active_project_path(
    path: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    *state.0.lock().unwrap() = Some(PathBuf::from(path));
    Ok(())
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty_manager::PtyManager::default())
        .manage(graph_runner::GraphRunnerState::default())
        .manage(git_engine::GitEngineState::default())
        .manage(mcp::McpManagerState::default())
        .manage(ProjectState::default())
        .manage(workspace_fs::WorkspaceWatcherState::default())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            set_active_project_path,
            pty_manager::spawn_pty,
            pty_manager::write_pty,
            pty_manager::resize_pty,
            pty_manager::destroy_pty,
            memory::engine::create_memory_record,
            memory::engine::query_memory_graph,
            memory::engine::list_aimem_facts,
            graph_runner::execute_graph,
            git_engine::list_active_worktrees,
            git_engine::rollback_worktree,
            git_engine::get_repo_head,
            git_engine::get_git_diff,
            git_engine::get_diff_for_commit,
            git_engine::get_git_status,
            git_engine::get_file_at_head,
            ephemeral::run_ephemeral_command,
            mcp::commands::mcp_connect_server,
            mcp::commands::mcp_disconnect_server,
            mcp::commands::mcp_list_tools,
            mcp::commands::mcp_call_tool,
            mcp::commands::mcp_list_servers,
            project::list_projects,
            project::create_project,
            project::list_pipelines,
            project::create_pipeline,
            project::rename_pipeline,
            project::duplicate_pipeline,
            project::delete_pipeline,
            project::save_pipeline_graph,
            project::load_pipeline_graph,
            project::ensure_project_workspace,
            project::get_default_projects_location,
            project::set_default_projects_location,
            project::pick_folder,
            workspace_fs::list_dir,
            workspace_fs::read_file,
            workspace_fs::write_file,
            workspace_fs::create_file,
            workspace_fs::create_dir,
            workspace_fs::rename_path,
            workspace_fs::delete_path,
            workspace_fs::start_workspace_watcher,
            workspace_fs::stop_workspace_watcher,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
