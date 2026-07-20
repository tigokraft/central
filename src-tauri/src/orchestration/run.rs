use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex as TokioMutex};
use tokio::task::JoinSet;
use tokio::time::{sleep, Duration};

use crate::agents::{render_task_command, AgentLaunchOptions, AgentRegistry};
use crate::git_engine::{GitEngineState, PromoteResult};

use super::scheduler::runnable_tasks;
use super::task::{MergePolicy, OrchestratorTask, TaskState};

// How often the dispatcher re-evaluates which tasks can start. Run durations are agent-call
// length (seconds to minutes), so a sub-second poll interval costs nothing observable while
// keeping the scheduler a simple, easy-to-reason-about loop instead of a fully event-driven one.
const POLL_INTERVAL: Duration = Duration::from_millis(300);

static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn new_run_id() -> String {
    let seq = RUN_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("run-{}-{}", now_millis(), seq)
}

// --- Events ---

// `rename_all` on the enum itself only camelCases the variant tag ("TaskState" -> "taskState");
// it does NOT cascade into a struct variant's own field names, so each variant with named
// fields needs its own `rename_all` too, or those fields serialize as their literal snake_case
// Rust names (bit us once already: task_id/retry_count reached the frontend un-renamed, so
// `event.taskId` was always undefined there).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum RunEvent {
    #[serde(rename = "taskState", rename_all = "camelCase")]
    TaskState {
        task_id: String,
        state: TaskState,
        retry_count: u32,
        message: Option<String>,
    },
    #[serde(rename = "runComplete", rename_all = "camelCase")]
    RunComplete {
        done: usize,
        failed: usize,
        awaiting_confirmation: bool,
        auto_promoted: bool,
    },
    #[serde(rename = "runFailed")]
    RunFailed { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestrationEventPayload {
    run_id: String,
    project_id: String,
    event: RunEvent,
}

fn emit_run_event(app: &AppHandle, run_id: &str, project_id: &str, event: RunEvent) {
    let result = app.emit(
        "orchestration-event",
        OrchestrationEventPayload {
            run_id: run_id.to_string(),
            project_id: project_id.to_string(),
            event,
        },
    );
    if let Err(e) = result {
        eprintln!(
            "[event] run={} FAILED to emit orchestration-event: {}",
            run_id, e
        );
    }
}

async fn set_task_state(
    app: &AppHandle,
    handle: &Arc<RunHandle>,
    task_id: &str,
    new_state: TaskState,
    retry_count: u32,
    message: Option<String>,
) {
    eprintln!(
        "[event] run={} task={} -> {:?} (retry={}, message={:?})",
        handle.run_id, task_id, new_state, retry_count, message
    );
    handle
        .states
        .lock()
        .await
        .insert(task_id.to_string(), new_state);
    emit_run_event(
        app,
        &handle.run_id,
        &handle.project_id,
        RunEvent::TaskState {
            task_id: task_id.to_string(),
            state: new_state,
            retry_count,
            message,
        },
    );
}

// --- Run state ---

struct RunHandle {
    run_id: String,
    project_id: String,
    repo_root: PathBuf,
    tasks: Vec<OrchestratorTask>,
    merge_policy: MergePolicy,
    states: TokioMutex<HashMap<String, TaskState>>,
    retry_counts: TokioMutex<HashMap<String, u32>>,
    // A task's current prompt: the original from the task list, or (after a bounce) that
    // original with the merge/test failure output appended, so a retried agent sees why its
    // previous attempt didn't land.
    prompts: TokioMutex<HashMap<String, String>>,
}

#[derive(Default)]
pub struct OrchestrationState {
    runs: Mutex<HashMap<String, Arc<RunHandle>>>,
    // One active run per project at a time, mirroring GraphRunnerState's single-flight guard —
    // two runs racing to reset/merge the same `central/staging` branch would corrupt it.
    active_project_runs: Mutex<HashMap<String, String>>,
}

fn default_max_parallel() -> usize {
    3
}
fn default_retry_limit() -> u32 {
    2
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOrchestrationRunRequest {
    pub project_id: String,
    pub tasks: Vec<OrchestratorTask>,
    pub adapter_id: String,
    #[serde(default)]
    pub options: AgentLaunchOptions,
    #[serde(default = "default_max_parallel")]
    pub max_parallel: usize,
    #[serde(default = "default_retry_limit")]
    pub retry_limit: u32,
    #[serde(default)]
    pub merge_policy: MergePolicy,
    #[serde(default)]
    pub test_command: Option<String>,
}

#[tauri::command]
pub async fn start_orchestration_run(
    request: StartOrchestrationRunRequest,
    app: AppHandle,
    state: State<'_, OrchestrationState>,
) -> Result<String, String> {
    if request.tasks.is_empty() {
        return Err("Task list is empty".to_string());
    }
    {
        let registry = app.state::<AgentRegistry>();
        if registry.get(&request.adapter_id).is_none() {
            return Err(format!("Unknown agent adapter: {}", request.adapter_id));
        }
    }

    let repo_root = crate::project::resolve_project_workspace(&app, &request.project_id)?;

    {
        let mut active = state.active_project_runs.lock().unwrap();
        if active.contains_key(&request.project_id) {
            return Err("An orchestration run is already active for this project".to_string());
        }
        active.insert(request.project_id.clone(), String::new());
    }

    let reset_result = app
        .state::<GitEngineState>()
        .reset_staging(&request.project_id, &repo_root);
    if let Err(e) = reset_result {
        state
            .active_project_runs
            .lock()
            .unwrap()
            .remove(&request.project_id);
        return Err(e);
    }

    let run_id = new_run_id();
    eprintln!(
        "[orchestration] start_orchestration_run run={} project={} adapter={} tasks={} max_parallel={} retry_limit={}",
        run_id,
        request.project_id,
        request.adapter_id,
        request.tasks.len(),
        request.max_parallel,
        request.retry_limit
    );
    for t in &request.tasks {
        eprintln!(
            "[orchestration]   task id={:?} title={:?} scopes={:?} dependsOn={:?}",
            t.id, t.title, t.file_scopes, t.depends_on
        );
    }
    state
        .active_project_runs
        .lock()
        .unwrap()
        .insert(request.project_id.clone(), run_id.clone());

    let prompts = request
        .tasks
        .iter()
        .map(|t| (t.id.clone(), t.prompt.clone()))
        .collect();

    let handle = Arc::new(RunHandle {
        run_id: run_id.clone(),
        project_id: request.project_id.clone(),
        repo_root,
        tasks: request.tasks,
        merge_policy: request.merge_policy,
        states: TokioMutex::new(HashMap::new()),
        retry_counts: TokioMutex::new(HashMap::new()),
        prompts: TokioMutex::new(prompts),
    });
    state
        .runs
        .lock()
        .unwrap()
        .insert(run_id.clone(), handle.clone());

    let app_for_run = app.clone();
    let run_id_for_spawn = run_id.clone();
    eprintln!(
        "[orchestration] spawning run_orchestration run={}",
        run_id_for_spawn
    );
    tauri::async_runtime::spawn(async move {
        eprintln!(
            "[orchestration] run_orchestration task started run={}",
            run_id_for_spawn
        );
        run_orchestration(
            app_for_run,
            handle,
            request.adapter_id,
            request.options,
            request.max_parallel.max(1),
            request.retry_limit,
            request.test_command,
        )
        .await;
        eprintln!(
            "[orchestration] run_orchestration task finished run={}",
            run_id_for_spawn
        );
    });

    Ok(run_id)
}

/// Confirms promotion of a finished run's `central/staging` branch into the project's checked
/// out branch — the human-gate confirmation step, and also usable to manually promote an
/// auto-if-green run that failed to auto-promote. Callable any time after the run has stopped
/// dispatching new work, regardless of whether every task succeeded, so a partially-green run
/// can still be promoted for whatever did land.
#[tauri::command]
pub fn confirm_run_promotion(
    run_id: String,
    app: AppHandle,
    state: State<'_, OrchestrationState>,
) -> Result<PromoteResult, String> {
    let handle = state
        .runs
        .lock()
        .unwrap()
        .get(&run_id)
        .cloned()
        .ok_or_else(|| format!("Unknown run id: {}", run_id))?;

    let git_state = app.state::<GitEngineState>();
    git_state.promote_staging_to_main(&handle.project_id, &handle.repo_root)
}

// --- Dispatcher ---

struct TaskCompletion {
    task_id: String,
}

async fn run_orchestration(
    app: AppHandle,
    handle: Arc<RunHandle>,
    adapter_id: String,
    agent_options: AgentLaunchOptions,
    max_parallel: usize,
    retry_limit: u32,
    test_command: Option<String>,
) {
    let (tx, rx) = mpsc::channel::<TaskCompletion>(handle.tasks.len().max(1));

    let integrator = tokio::spawn(run_integrator(
        app.clone(),
        handle.clone(),
        rx,
        retry_limit,
        test_command,
    ));

    // `tx` (and every clone handed to a per-task future below) must be fully dropped before the
    // integrator's `rx.recv()` can return `None` and let it finish — this function's own `tx`
    // binding going out of scope here is what ultimately signals that.
    run_dispatcher(
        app.clone(),
        handle.clone(),
        adapter_id,
        agent_options,
        max_parallel,
        tx,
    )
    .await;
    eprintln!("[orchestration] run={} dispatcher returned", handle.run_id);

    let integrator_result = integrator.await;
    eprintln!(
        "[orchestration] run={} integrator joined, panicked={}",
        handle.run_id,
        integrator_result.is_err()
    );

    finalize_run(&app, &handle).await;

    app.state::<OrchestrationState>()
        .active_project_runs
        .lock()
        .unwrap()
        .remove(&handle.project_id);
}

async fn run_dispatcher(
    app: AppHandle,
    handle: Arc<RunHandle>,
    adapter_id: String,
    agent_options: AgentLaunchOptions,
    max_parallel: usize,
    tx: mpsc::Sender<TaskCompletion>,
) {
    let mut task_futures: JoinSet<()> = JoinSet::new();
    eprintln!(
        "[dispatcher] run={} entering loop with {} tasks, max_parallel={}",
        handle.run_id,
        handle.tasks.len(),
        max_parallel
    );

    loop {
        let (runnable, all_terminal, has_active, snapshot) = {
            let states = handle.states.lock().await;
            let runnable = runnable_tasks(&handle.tasks, &states, max_parallel);
            let all_terminal = handle.tasks.iter().all(|t| {
                matches!(
                    states.get(&t.id).copied().unwrap_or(TaskState::Pending),
                    TaskState::Done | TaskState::Failed
                )
            });
            let has_active = states
                .values()
                .any(|s| matches!(s, TaskState::Running | TaskState::Merging));
            let snapshot: Vec<(String, TaskState)> = handle
                .tasks
                .iter()
                .map(|t| {
                    (
                        t.id.clone(),
                        states.get(&t.id).copied().unwrap_or(TaskState::Pending),
                    )
                })
                .collect();
            (runnable, all_terminal, has_active, snapshot)
        };
        eprintln!(
            "[dispatcher] run={} tick: states={:?} runnable={:?} all_terminal={} has_active={} in_flight={}",
            handle.run_id,
            snapshot,
            runnable,
            all_terminal,
            has_active,
            task_futures.len()
        );

        if !runnable.is_empty() {
            {
                let mut states = handle.states.lock().await;
                for id in &runnable {
                    states.insert(id.clone(), TaskState::Running);
                }
            }
            for task_id in runnable {
                let app = app.clone();
                let handle = handle.clone();
                let adapter_id = adapter_id.clone();
                let agent_options = agent_options.clone();
                let tx = tx.clone();
                task_futures.spawn(async move {
                    run_single_task(app, handle, task_id, adapter_id, agent_options, tx).await;
                });
            }
        }

        while task_futures.try_join_next().is_some() {}

        if all_terminal && !has_active && task_futures.is_empty() {
            break;
        }

        if !has_active && task_futures.is_empty() && !all_terminal {
            // Nothing running or merging, nothing newly runnable, yet some tasks remain
            // non-terminal: they're `Pending` behind a dependency that ultimately `Failed`.
            // Cascade-fail them so the run reaches a terminal state instead of idling forever.
            let states = handle.states.lock().await;
            let blocked: Vec<String> = handle
                .tasks
                .iter()
                .map(|t| t.id.clone())
                .filter(|id| {
                    states.get(id).copied().unwrap_or(TaskState::Pending) == TaskState::Pending
                })
                .collect();
            drop(states);
            for task_id in blocked {
                set_task_state(
                    &app,
                    &handle,
                    &task_id,
                    TaskState::Failed,
                    0,
                    Some("Blocked on a dependency that failed".to_string()),
                )
                .await;
            }
            break;
        }

        sleep(POLL_INTERVAL).await;
    }

    while task_futures.join_next().await.is_some() {}
}

async fn run_single_task(
    app: AppHandle,
    handle: Arc<RunHandle>,
    task_id: String,
    adapter_id: String,
    agent_options: AgentLaunchOptions,
    tx: mpsc::Sender<TaskCompletion>,
) {
    eprintln!("[task {}] run={} starting", task_id, handle.run_id);
    let retry_count = *handle.retry_counts.lock().await.get(&task_id).unwrap_or(&0);
    set_task_state(
        &app,
        &handle,
        &task_id,
        TaskState::Running,
        retry_count,
        None,
    )
    .await;

    let worktree = app.state::<GitEngineState>().create_task_worktree(
        &handle.project_id,
        &handle.repo_root,
        &task_id,
    );
    eprintln!("[task {}] create_task_worktree -> {:?}", task_id, worktree);
    let worktree = match worktree {
        Ok(p) => p,
        Err(e) => {
            set_task_state(
                &app,
                &handle,
                &task_id,
                TaskState::Failed,
                retry_count,
                Some(format!("Failed to create task worktree: {e}")),
            )
            .await;
            return;
        }
    };

    let adapter = {
        let registry = app.state::<AgentRegistry>();
        registry.get(&adapter_id)
    };
    let Some(adapter) = adapter else {
        set_task_state(
            &app,
            &handle,
            &task_id,
            TaskState::Failed,
            retry_count,
            Some(format!("Unknown agent adapter: {adapter_id}")),
        )
        .await;
        return;
    };
    let command = render_task_command(&adapter, &agent_options);
    let prompt = handle
        .prompts
        .lock()
        .await
        .get(&task_id)
        .cloned()
        .unwrap_or_default();
    let node_id = format!("orchestration-{}-{}", handle.run_id, task_id);
    eprintln!(
        "[task {}] adapter={} cwd={:?} command={:?}",
        task_id, adapter_id, worktree, command
    );

    let result = crate::graph_runner::run_shell_command_raw(
        &app,
        &node_id,
        &command,
        &worktree,
        &[("CENTRAL_PIPELINE_INPUT", prompt.as_str())],
    )
    .await;
    eprintln!(
        "[task {}] run_shell_command_raw -> ok={} exit={:?}",
        task_id,
        result.is_ok(),
        result.as_ref().ok().map(|(_, code)| *code)
    );

    match result {
        Ok((_output, 0)) => {
            set_task_state(
                &app,
                &handle,
                &task_id,
                TaskState::Merging,
                retry_count,
                None,
            )
            .await;
            let _ = tx.send(TaskCompletion { task_id }).await;
        }
        Ok((output, code)) => {
            set_task_state(
                &app,
                &handle,
                &task_id,
                TaskState::Failed,
                retry_count,
                Some(format!("Agent exited with code {code}:\n{output}")),
            )
            .await;
        }
        Err(e) => {
            set_task_state(
                &app,
                &handle,
                &task_id,
                TaskState::Failed,
                retry_count,
                Some(e),
            )
            .await;
        }
    }
}

// --- Integrator: strictly sequential merge queue ---

async fn run_integrator(
    app: AppHandle,
    handle: Arc<RunHandle>,
    mut rx: mpsc::Receiver<TaskCompletion>,
    retry_limit: u32,
    test_command: Option<String>,
) {
    eprintln!("[integrator] run={} waiting for completions", handle.run_id);
    while let Some(TaskCompletion { task_id }) = rx.recv().await {
        eprintln!(
            "[integrator] run={} received completion for task={}",
            handle.run_id, task_id
        );
        let merge_result = app.state::<GitEngineState>().merge_task_into_staging(
            &handle.project_id,
            &handle.repo_root,
            &task_id,
        );
        eprintln!(
            "[integrator] task={} merge_task_into_staging -> {:?}",
            task_id, merge_result
        );

        if let Err(e) = merge_result {
            bounce_or_fail(
                &app,
                &handle,
                &task_id,
                retry_limit,
                format!("Merge conflict: {e}"),
            )
            .await;
            continue;
        }

        if let Some(cmd) = test_command.as_deref().filter(|c| !c.trim().is_empty()) {
            let staging_path = app
                .state::<GitEngineState>()
                .refresh_staging_worktree(&handle.project_id, &handle.repo_root);
            let staging_path = match staging_path {
                Ok(p) => p,
                Err(e) => {
                    bounce_or_fail(
                        &app,
                        &handle,
                        &task_id,
                        retry_limit,
                        format!("Failed to prepare staging worktree for tests: {e}"),
                    )
                    .await;
                    continue;
                }
            };
            let node_id = format!("orchestration-{}-tests-{}", handle.run_id, task_id);
            let test_result =
                crate::graph_runner::run_shell_command_raw(&app, &node_id, cmd, &staging_path, &[])
                    .await;
            match test_result {
                Ok((_out, 0)) => {}
                Ok((out, code)) => {
                    bounce_or_fail(
                        &app,
                        &handle,
                        &task_id,
                        retry_limit,
                        format!("Test command exited with code {code}:\n{out}"),
                    )
                    .await;
                    continue;
                }
                Err(e) => {
                    bounce_or_fail(&app, &handle, &task_id, retry_limit, e).await;
                    continue;
                }
            }
        }

        let retry_count = *handle.retry_counts.lock().await.get(&task_id).unwrap_or(&0);
        set_task_state(&app, &handle, &task_id, TaskState::Done, retry_count, None).await;
    }
}

async fn bounce_or_fail(
    app: &AppHandle,
    handle: &Arc<RunHandle>,
    task_id: &str,
    retry_limit: u32,
    error_output: String,
) {
    let retry_count = {
        let mut retry_counts = handle.retry_counts.lock().await;
        let used = retry_counts.entry(task_id.to_string()).or_insert(0);
        *used += 1;
        *used
    };

    if retry_count <= retry_limit {
        {
            let original = handle
                .tasks
                .iter()
                .find(|t| t.id == task_id)
                .map(|t| t.prompt.clone())
                .unwrap_or_default();
            let updated = format!(
                "{original}\n\n---\nA previous attempt (try {retry_count}/{retry_limit}) failed to merge or pass tests. \
                 Fix the issue below and try again:\n{error_output}"
            );
            handle
                .prompts
                .lock()
                .await
                .insert(task_id.to_string(), updated);
        }
        set_task_state(
            app,
            handle,
            task_id,
            TaskState::Bounced,
            retry_count,
            Some(error_output),
        )
        .await;
        // Bounced is transient — flip straight back to Pending so the dispatcher's next tick
        // picks it up again against a fresh worktree off the current staging tip.
        set_task_state(app, handle, task_id, TaskState::Pending, retry_count, None).await;
    } else {
        set_task_state(
            app,
            handle,
            task_id,
            TaskState::Failed,
            retry_count,
            Some(error_output),
        )
        .await;
    }
}

// --- Finalization ---

async fn finalize_run(app: &AppHandle, handle: &Arc<RunHandle>) {
    let (done, failed) = {
        let states = handle.states.lock().await;
        let done = handle
            .tasks
            .iter()
            .filter(|t| states.get(&t.id) == Some(&TaskState::Done))
            .count();
        let failed = handle
            .tasks
            .iter()
            .filter(|t| states.get(&t.id) == Some(&TaskState::Failed))
            .count();
        (done, failed)
    };

    let mut auto_promoted = false;
    let mut awaiting_confirmation = false;

    if done > 0 {
        match handle.merge_policy {
            MergePolicy::AutoIfGreen if failed == 0 => {
                let result = app
                    .state::<GitEngineState>()
                    .promote_staging_to_main(&handle.project_id, &handle.repo_root);
                match result {
                    Ok(_) => auto_promoted = true,
                    Err(e) => {
                        emit_run_event(
                            app,
                            &handle.run_id,
                            &handle.project_id,
                            RunEvent::RunFailed {
                                message: format!("Auto-promotion to main failed: {e}"),
                            },
                        );
                        awaiting_confirmation = true;
                    }
                }
            }
            _ => {
                awaiting_confirmation = true;
            }
        }
    }

    emit_run_event(
        app,
        &handle.run_id,
        &handle.project_id,
        RunEvent::RunComplete {
            done,
            failed,
            awaiting_confirmation,
            auto_promoted,
        },
    );
}

#[cfg(test)]
mod event_serialization_tests {
    use super::*;

    // Regression test: `rename_all` on the enum itself only camelCases the variant tag, not a
    // struct variant's own fields — this shape is exactly what the frontend's TS types
    // (src/lib/orchestrator/runEvents.ts) deserialize against, so a mismatch here silently
    // breaks every taskId-keyed lookup client-side without any error on either end.
    #[test]
    fn task_state_event_serializes_as_camel_case() {
        let event = RunEvent::TaskState {
            task_id: "string-formatter".to_string(),
            state: TaskState::Running,
            retry_count: 1,
            message: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "taskState");
        assert_eq!(json["taskId"], "string-formatter");
        assert_eq!(json["state"], "running");
        assert_eq!(json["retryCount"], 1);
        assert!(json.get("task_id").is_none());
        assert!(json.get("retry_count").is_none());
    }

    #[test]
    fn run_complete_event_serializes_as_camel_case() {
        let event = RunEvent::RunComplete {
            done: 3,
            failed: 1,
            awaiting_confirmation: true,
            auto_promoted: false,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "runComplete");
        assert_eq!(json["awaitingConfirmation"], true);
        assert_eq!(json["autoPromoted"], false);
        assert!(json.get("awaiting_confirmation").is_none());
    }

    #[test]
    fn run_failed_event_serializes_with_camel_case_tag() {
        let event = RunEvent::RunFailed {
            message: "boom".to_string(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "runFailed");
        assert_eq!(json["message"], "boom");
    }
}
