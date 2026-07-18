mod adapter;
mod claude_code;
mod event;
mod generic;
mod path_detect;

pub use adapter::{AgentAdapter, AgentLaunchOptions};
pub use event::AgentEvent;

use claude_code::ClaudeCodeAdapter;
use generic::GenericCommandAdapter;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

pub struct AgentRegistry {
    adapters: Vec<Arc<dyn AgentAdapter>>,
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self {
            adapters: vec![Arc::new(ClaudeCodeAdapter), Arc::new(GenericCommandAdapter)],
        }
    }
}

impl AgentRegistry {
    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters.iter().find(|a| a.id() == id).cloned()
    }
}

#[derive(Serialize, Clone)]
pub struct AgentAvailability {
    pub id: String,
    pub display_name: String,
    pub available: bool,
}

#[derive(Serialize, Clone)]
struct AgentEventPayload {
    node_id: String,
    event: AgentEvent,
}

pub fn emit_agent_event(app_handle: &AppHandle, node_id: &str, event: AgentEvent) {
    let _ = app_handle.emit(
        "agent-event",
        AgentEventPayload {
            node_id: node_id.to_string(),
            event,
        },
    );
}

#[tauri::command]
pub fn list_available_agents(registry: State<'_, AgentRegistry>) -> Vec<AgentAvailability> {
    registry
        .adapters
        .iter()
        .map(|a| AgentAvailability {
            id: a.id().to_string(),
            display_name: a.display_name().to_string(),
            available: a.detect(),
        })
        .collect()
}

// Bundled into one struct (rather than five separate command parameters) to keep
// launch_agent_session's argument count down; the frontend passes it as a single `request`
// object.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAgentSessionRequest {
    pub node_id: String,
    pub adapter_id: String,
    pub prompt: String,
    pub cwd: String,
    pub options: Option<AgentLaunchOptions>,
}

#[tauri::command]
pub fn launch_agent_session(
    request: LaunchAgentSessionRequest,
    pty_state: State<'_, crate::pty_manager::PtyManager>,
    registry: State<'_, AgentRegistry>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let LaunchAgentSessionRequest {
        node_id,
        adapter_id,
        prompt,
        cwd,
        options,
    } = request;
    let adapter = registry
        .get(&adapter_id)
        .ok_or_else(|| format!("Unknown agent adapter: {adapter_id}"))?;
    let options = options.unwrap_or_default();
    let cwd_path = PathBuf::from(&cwd);
    let launch = adapter.build_launch(&prompt, &cwd_path, &options);

    let mut cmd = CommandBuilder::new(&launch.program);
    for arg in &launch.args {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd_path);

    // Started is synthesized here (spawn success), not parsed from output, so it fires for
    // every adapter uniformly — GenericCommand's parse_line never derives events from content.
    emit_agent_event(&app_handle, &node_id, AgentEvent::Started);

    // Shared between the two hooks so the exit hook can tell whether the adapter already
    // reported a Done from content (e.g. ClaudeCode's "result" line) and skip its own.
    let seen_done = Arc::new(AtomicBool::new(false));

    let on_line: crate::pty_manager::PtyLineHook = {
        let adapter = adapter.clone();
        let app_handle = app_handle.clone();
        let node_id = node_id.clone();
        let seen_done = seen_done.clone();
        Arc::new(move |line: &str| {
            if let Some(event) = adapter.parse_line(line) {
                if matches!(event, AgentEvent::Done { .. }) {
                    seen_done.store(true, Ordering::SeqCst);
                }
                emit_agent_event(&app_handle, &node_id, event);
            }
        })
    };

    let on_exit: crate::pty_manager::PtyExitHook = {
        let app_handle = app_handle.clone();
        let node_id = node_id.clone();
        Arc::new(move |exit_code: Option<i32>| {
            if !seen_done.load(Ordering::SeqCst) {
                emit_agent_event(
                    &app_handle,
                    &node_id,
                    AgentEvent::Done {
                        exit_code: exit_code.unwrap_or(-1),
                        summary: None,
                    },
                );
            }
        })
    };

    let node_id_for_stdin = node_id.clone();
    crate::pty_manager::spawn_pty_command(
        node_id,
        cmd,
        120,
        40,
        &pty_state,
        &app_handle,
        crate::pty_manager::PtyHooks {
            on_line: Some(on_line),
            on_exit: Some(on_exit),
        },
    )?;

    // Delivered after spawn, the way a human would type it in — the PTY buffers input
    // regardless of whether the child has called read() yet, so this can't race the process
    // becoming ready.
    if let Some(stdin_prompt) = launch.stdin_prompt {
        crate::pty_manager::write_pty_data(
            &node_id_for_stdin,
            &format!("{stdin_prompt}\n"),
            &pty_state,
        )?;
    }

    Ok(())
}

#[tauri::command]
pub fn send_agent_input(
    node_id: String,
    text: String,
    pty_state: State<'_, crate::pty_manager::PtyManager>,
) -> Result<(), String> {
    crate::pty_manager::write_pty_data(&node_id, &format!("{text}\n"), &pty_state)
}
