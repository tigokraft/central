mod adapter;
mod claude_code;
mod event;
mod generic;
mod path_detect;

pub use adapter::{AgentAdapter, AgentLaunchOptions, LaunchSpec};
pub use event::AgentEvent;

use claude_code::ClaudeCodeAdapter;
use generic::GenericCommandAdapter;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    // Layered on top of the inherited process environment (CommandBuilder starts pre-populated
    // from it), so a profile-configured var like a headless CLI auth token doesn't require the
    // user to export anything in the shell that launched the app.
    for (key, value) in &options.env {
        cmd.env(key, value);
    }

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

// Literal placeholder passed as an adapter's "prompt" when rendering a headless invocation as a
// reusable shell command line: graph_runner.rs already exports every node's upstream context as
// this exact env var (see run_shell_command in graph_runner.rs), so an arg/stdin payload that
// equals this sentinel is emitted still-expandable (double-quoted) rather than escaped as a
// literal, letting one rendered command line work for any prompt text at run time.
const PIPELINE_INPUT_SENTINEL: &str = "$CENTRAL_PIPELINE_INPUT";

// POSIX single-quote escaping: safe for any literal argument value (flags, models, templates)
// since single quotes suppress all expansion inside sh -c.
fn single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// Renders an adapter's LaunchSpec (built with prompt == PIPELINE_INPUT_SENTINEL) as a single
// `sh -c`-safe command line string, suitable for a materialized actionContainerNode's `actions`
// entry. Every literal arg is single-quoted; the one arg that carries the prompt (or the
// stdin-delivered prompt) is instead double-quoted so the shell expands it against whatever
// CENTRAL_PIPELINE_INPUT holds at execution time. `env` is prefixed as POSIX
// `KEY='value' ...` assignments (sorted for deterministic output) scoped to just this command,
// so a profile-configured var (e.g. a headless CLI auth token) reaches the process without the
// user having to export anything in their own shell — graph_runner.rs's `sh -c` execution
// already supports this syntax with no changes needed there.
pub fn render_launch_as_shell_command(
    launch: &LaunchSpec,
    env: &HashMap<String, String>,
) -> String {
    let mut sorted_env: Vec<(&String, &String)> = env.iter().collect();
    sorted_env.sort_by_key(|(k, _)| k.as_str());
    let env_prefix: String = sorted_env
        .iter()
        .map(|(k, v)| format!("{k}={} ", single_quote(v)))
        .collect();

    let mut parts = vec![single_quote(&launch.program)];
    for arg in &launch.args {
        if arg == PIPELINE_INPUT_SENTINEL {
            parts.push(format!("\"{PIPELINE_INPUT_SENTINEL}\""));
        } else {
            parts.push(single_quote(arg));
        }
    }
    let cmd = parts.join(" ");

    let piped = match launch.stdin_prompt.as_deref() {
        Some(s) if s == PIPELINE_INPUT_SENTINEL => {
            format!("printf '%s' \"{PIPELINE_INPUT_SENTINEL}\" | {cmd}")
        }
        Some(other) => format!("printf '%s' {} | {cmd}", single_quote(other)),
        None => cmd,
    };

    format!("{env_prefix}{piped}")
}

// Renders the given adapter's headless CLI invocation as a shell command line that reads its
// prompt from $CENTRAL_PIPELINE_INPUT at run time, for embedding directly into a materialized
// task node's `actions` list. Adapter-agnostic by construction: it only ever calls the trait's
// own build_launch, so a future adapter needs no changes here to work with the orchestrator.
#[tauri::command]
pub fn build_task_command_line(
    adapter_id: String,
    options: Option<AgentLaunchOptions>,
    registry: State<'_, AgentRegistry>,
) -> Result<String, String> {
    let adapter = registry
        .get(&adapter_id)
        .ok_or_else(|| format!("Unknown agent adapter: {adapter_id}"))?;
    let options = options.unwrap_or_default();
    let launch = adapter.build_launch(
        PIPELINE_INPUT_SENTINEL,
        PathBuf::from(".").as_path(),
        &options,
    );
    Ok(render_launch_as_shell_command(&launch, &options.env))
}

#[cfg(test)]
mod command_line_tests {
    use super::*;

    #[test]
    fn claude_code_default_options_renders_expected_command() {
        let adapter = ClaudeCodeAdapter;
        let launch = adapter.build_launch(
            PIPELINE_INPUT_SENTINEL,
            PathBuf::from(".").as_path(),
            &AgentLaunchOptions::default(),
        );
        assert_eq!(
            render_launch_as_shell_command(&launch, &HashMap::new()),
            "'claude' '-p' \"$CENTRAL_PIPELINE_INPUT\" '--output-format' 'stream-json' '--verbose'"
        );
    }

    #[test]
    fn claude_code_with_model_and_extra_args_renders_expected_command() {
        let adapter = ClaudeCodeAdapter;
        let options = AgentLaunchOptions {
            model: Some("sonnet".to_string()),
            extra_args: vec!["--effort".to_string(), "high".to_string()],
            ..Default::default()
        };
        let launch = adapter.build_launch(
            PIPELINE_INPUT_SENTINEL,
            PathBuf::from(".").as_path(),
            &options,
        );
        assert_eq!(
            render_launch_as_shell_command(&launch, &HashMap::new()),
            "'claude' '-p' \"$CENTRAL_PIPELINE_INPUT\" '--output-format' 'stream-json' '--verbose' '--model' 'sonnet' '--effort' 'high'"
        );
    }

    #[test]
    fn env_vars_are_prefixed_sorted_and_single_quoted() {
        let adapter = ClaudeCodeAdapter;
        let launch = adapter.build_launch(
            PIPELINE_INPUT_SENTINEL,
            PathBuf::from(".").as_path(),
            &AgentLaunchOptions::default(),
        );
        let env = HashMap::from([
            (
                "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
                "it's a token".to_string(),
            ),
            ("ANTHROPIC_LOG".to_string(), "debug".to_string()),
        ]);
        assert_eq!(
            render_launch_as_shell_command(&launch, &env),
            "ANTHROPIC_LOG='debug' CLAUDE_CODE_OAUTH_TOKEN='it'\\''s a token' 'claude' '-p' \"$CENTRAL_PIPELINE_INPUT\" '--output-format' 'stream-json' '--verbose'"
        );
    }

    #[test]
    fn generic_command_with_template_uses_stdin_pipe() {
        let adapter = GenericCommandAdapter;
        let options = AgentLaunchOptions {
            command_template: Some("sh -c 'echo hi; sleep 1'".to_string()),
            ..Default::default()
        };
        let launch = adapter.build_launch(
            PIPELINE_INPUT_SENTINEL,
            PathBuf::from(".").as_path(),
            &options,
        );
        assert_eq!(
            render_launch_as_shell_command(&launch, &HashMap::new()),
            "printf '%s' \"$CENTRAL_PIPELINE_INPUT\" | 'sh' '-c' 'echo hi; sleep 1'"
        );
    }

    #[test]
    fn generic_command_without_template_runs_prompt_as_shell_command() {
        let adapter = GenericCommandAdapter;
        let launch = adapter.build_launch(
            PIPELINE_INPUT_SENTINEL,
            PathBuf::from(".").as_path(),
            &AgentLaunchOptions::default(),
        );
        assert_eq!(
            render_launch_as_shell_command(&launch, &HashMap::new()),
            "'sh' '-c' \"$CENTRAL_PIPELINE_INPUT\""
        );
    }

    #[test]
    fn single_quote_escapes_embedded_single_quotes() {
        assert_eq!(single_quote("it's fine"), "'it'\\''s fine'");
    }
}
