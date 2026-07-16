mod pty_manager;
mod graph_runner;
mod git_engine;
mod ephemeral;
pub mod memory;

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
        .setup(|app| {
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
            pty_manager::spawn_pty,
            pty_manager::write_pty,
            pty_manager::resize_pty,
            pty_manager::destroy_pty,
            memory::engine::create_memory_record,
            memory::engine::query_memory_graph,
            memory::engine::supersede_record,
            memory::engine::export_to_obsidian,
            graph_runner::execute_graph,
            git_engine::list_active_worktrees,
            git_engine::rollback_worktree,
            git_engine::get_repo_head,
            ephemeral::run_ephemeral_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
