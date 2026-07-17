use central_core::project::*;
use central_core::*;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty_manager::PtyManager::default())
        .manage(graph_runner::GraphRunnerState::default())
        .manage(git_engine::GitEngineState::default())
        .manage(mcp::McpManagerState::default())
        .manage(ProjectState::default())
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
            memory::engine::supersede_record,
            memory::engine::export_to_obsidian,
            memory::engine::list_aimem_facts,
            graph_runner::execute_graph,
            git_engine::list_active_worktrees,
            git_engine::rollback_worktree,
            git_engine::get_repo_head,
            git_engine::get_git_diff,
            ephemeral::run_ephemeral_command,
            mcp::commands::mcp_connect_server,
            mcp::commands::mcp_disconnect_server,
            mcp::commands::mcp_list_tools,
            mcp::commands::mcp_call_tool,
            mcp::commands::mcp_list_servers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
