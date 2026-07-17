use tauri::AppHandle;

use crate::graph_runner::{emit_event, run_shell_command_raw, NodeEventPayload};

// Runs a single disposable command outside the DAG execution graph, reusing the same
// node-start/node-streaming/node-success/node-fail event names the canvas already listens
// for, so a one-off ephemeral node lights up exactly like a graph node without needing one.
#[tauri::command]
pub async fn run_ephemeral_command(node_id: String, command: String, app: AppHandle) -> Result<(), String> {
    emit_event(
        &app,
        "node-start",
        NodeEventPayload {
            node_id: node_id.clone(),
            message: Some("Running ad-hoc check".to_string()),
            output: None,
            exit_code: None,
            retry_count: None,
            max_retries: None,
        },
    );

    let working_dir = crate::git_engine::resolve_repo_root(&app);
    let result = run_shell_command_raw(&app, &node_id, &command, &working_dir, &[]).await;

    match result {
        Ok((output, 0)) => {
            emit_event(
                &app,
                "node-success",
                NodeEventPayload {
                    node_id,
                    message: None,
                    output: Some(output),
                    exit_code: Some(0),
                    retry_count: None,
                    max_retries: None,
                },
            );
            Ok(())
        }
        Ok((output, code)) => {
            emit_event(
                &app,
                "node-fail",
                NodeEventPayload {
                    node_id,
                    message: Some(format!("Exited with code {}", code)),
                    output: Some(output),
                    exit_code: Some(code),
                    retry_count: None,
                    max_retries: None,
                },
            );
            Ok(())
        }
        Err(e) => {
            emit_event(
                &app,
                "node-fail",
                NodeEventPayload {
                    node_id,
                    message: Some(e.clone()),
                    output: None,
                    exit_code: None,
                    retry_count: None,
                    max_retries: None,
                },
            );
            Err(e)
        }
    }
}
