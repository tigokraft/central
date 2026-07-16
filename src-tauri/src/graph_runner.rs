use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use petgraph::algo::toposort;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::Direction;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as TokioMutex;

use crate::git_engine::GitEngineState;

const DEFAULT_MAX_RETRIES: u32 = 3;
const CHECK_NODE_TYPES: [&str; 2] = ["actionContainerNode", "terminalNode"];
const CODER_NODE_TYPE: &str = "promptNode";

#[derive(Debug, Deserialize, Clone)]
pub struct GraphNodeInput {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub data: NodeData,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct NodeData {
    pub label: Option<String>,
    pub prompt: Option<String>,
    pub note: Option<String>,
    pub description: Option<String>,
    pub actions: Option<Vec<String>>,
    pub facts: Option<Vec<String>>,
    pub command: Option<String>,
    #[serde(alias = "maxRetries")]
    pub max_retries: Option<u32>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct GraphEdgeInput {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeEventPayload {
    pub node_id: String,
    pub message: Option<String>,
    pub output: Option<String>,
    pub exit_code: Option<i32>,
    pub retry_count: Option<u32>,
    pub max_retries: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GraphEventPayload {
    ok: bool,
    message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CableHandoffPayload {
    source_node_id: String,
    target_node_id: String,
    commit_sha: String,
    insertions: usize,
    deletions: usize,
    files_changed: usize,
}

#[derive(Default)]
pub struct GraphRunnerState {
    running: Arc<AtomicBool>,
}

struct ExecutionContext {
    app: AppHandle,
    outputs: TokioMutex<HashMap<String, String>>,
    retry_counts: TokioMutex<HashMap<String, u32>>,
    // Serializes re-execution of a given node when multiple failing branches
    // route back to the same Coder ancestor concurrently.
    node_locks: HashMap<String, TokioMutex<()>>,
    graph: DiGraph<String, ()>,
    index_of: HashMap<String, NodeIndex>,
    node_of: HashMap<String, GraphNodeInput>,
    working_dir: PathBuf,
}

// Builds the petgraph DAG from the canvas nodes/edges and rejects cycles.
// Pure and AppHandle-free so it can be exercised directly in unit tests.
fn build_graph(
    nodes: &[GraphNodeInput],
    edges: &[GraphEdgeInput],
) -> Result<(DiGraph<String, ()>, HashMap<String, NodeIndex>), String> {
    let mut graph = DiGraph::<String, ()>::new();
    let mut index_of = HashMap::new();
    for n in nodes {
        index_of.insert(n.id.clone(), graph.add_node(n.id.clone()));
    }
    for e in edges {
        if let (Some(&s), Some(&t)) = (index_of.get(&e.source), index_of.get(&e.target)) {
            graph.add_edge(s, t, ());
        }
    }

    if toposort(&graph, None).is_err() {
        return Err("Execution graph contains a cycle".to_string());
    }

    Ok((graph, index_of))
}

fn build_context(
    nodes: Vec<GraphNodeInput>,
    edges: Vec<GraphEdgeInput>,
    app: AppHandle,
) -> Result<Arc<ExecutionContext>, String> {
    let (graph, index_of) = build_graph(&nodes, &edges)?;

    let node_locks = nodes.iter().map(|n| (n.id.clone(), TokioMutex::new(()))).collect();
    let node_of: HashMap<String, GraphNodeInput> =
        nodes.into_iter().map(|n| (n.id.clone(), n)).collect();

    let working_dir = crate::git_engine::resolve_repo_root();

    Ok(Arc::new(ExecutionContext {
        app,
        outputs: TokioMutex::new(HashMap::new()),
        retry_counts: TokioMutex::new(HashMap::new()),
        node_locks,
        graph,
        index_of,
        node_of,
        working_dir,
    }))
}

#[tauri::command]
pub fn execute_graph(
    nodes: Vec<GraphNodeInput>,
    edges: Vec<GraphEdgeInput>,
    app_handle: AppHandle,
    state: State<'_, GraphRunnerState>,
) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A pipeline is already running".to_string());
    }

    let ctx = match build_context(nodes, edges, app_handle.clone()) {
        Ok(ctx) => ctx,
        Err(e) => {
            state.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let running_flag = state.running.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_graph(ctx).await;
        let event = match &result {
            Ok(()) => GraphEventPayload { ok: true, message: None },
            Err(e) => GraphEventPayload { ok: false, message: Some(e.clone()) },
        };
        let _ = app_handle.emit(if result.is_ok() { "graph-complete" } else { "graph-error" }, event);
        running_flag.store(false, Ordering::SeqCst);
    });

    Ok(())
}

async fn run_graph(ctx: Arc<ExecutionContext>) -> Result<(), String> {
    let all_ids: Vec<String> = ctx.node_of.keys().cloned().collect();
    ctx.app.state::<GitEngineState>().prepare_run(&ctx.working_dir, &all_ids);

    let mut completed: HashSet<String> = HashSet::new();

    while completed.len() < all_ids.len() {
        let layer: Vec<String> = all_ids
            .iter()
            .filter(|id| !completed.contains(*id))
            .filter(|id| {
                let idx = ctx.index_of[*id];
                ctx.graph
                    .neighbors_directed(idx, Direction::Incoming)
                    .all(|p| completed.contains(&ctx.graph[p]))
            })
            .cloned()
            .collect();

        if layer.is_empty() {
            return Err("Execution stalled: unable to resolve next node layer".to_string());
        }

        let handles: Vec<_> = layer
            .iter()
            .cloned()
            .map(|node_id| tauri::async_runtime::spawn(run_node(ctx.clone(), node_id)))
            .collect();

        for (node_id, handle) in layer.into_iter().zip(handles) {
            match handle.await {
                Ok(Ok(())) => {
                    completed.insert(node_id);
                }
                Ok(Err(e)) => return Err(e),
                Err(join_err) => return Err(join_err.to_string()),
            }
        }
    }

    Ok(())
}

fn run_node(
    ctx: Arc<ExecutionContext>,
    node_id: String,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
    Box::pin(async move {
        let lock = ctx
            .node_locks
            .get(&node_id)
            .ok_or_else(|| format!("Unknown node id: {}", node_id))?;
        let _guard = lock.lock().await;
        execute_with_retries(&ctx, &node_id).await
    })
}

async fn execute_with_retries(ctx: &Arc<ExecutionContext>, node_id: &str) -> Result<(), String> {
    let node = ctx
        .node_of
        .get(node_id)
        .cloned()
        .ok_or_else(|| format!("Unknown node id: {}", node_id))?;
    let max_retries = node.data.max_retries.unwrap_or(DEFAULT_MAX_RETRIES);
    let is_check_node = CHECK_NODE_TYPES.contains(&node.node_type.as_str());

    loop {
        let input_context = gather_input_context(ctx, node_id).await;

        emit_event(
            &ctx.app,
            "node-start",
            NodeEventPayload {
                node_id: node_id.to_string(),
                message: Some(format!(
                    "Executing {}",
                    node.data.label.clone().unwrap_or_else(|| node_id.to_string())
                )),
                output: None,
                exit_code: None,
                retry_count: None,
                max_retries: Some(max_retries),
            },
        );

        let exec_result = run_node_body(ctx, node_id, &node, &input_context).await;

        match exec_result {
            Ok((output, 0)) => {
                ctx.outputs.lock().await.insert(node_id.to_string(), output.clone());
                emit_event(
                    &ctx.app,
                    "node-success",
                    NodeEventPayload {
                        node_id: node_id.to_string(),
                        message: None,
                        output: Some(output),
                        exit_code: Some(0),
                        retry_count: None,
                        max_retries: Some(max_retries),
                    },
                );
                perform_handoffs(ctx, node_id);
                return Ok(());
            }
            Ok((output, exit_code)) => {
                if is_check_node {
                    let mut counts = ctx.retry_counts.lock().await;
                    let used = counts.entry(node_id.to_string()).or_insert(0);
                    if *used < max_retries {
                        if let Some(coder_id) =
                            find_nearest_coder_ancestor(&ctx.graph, &ctx.index_of, &ctx.node_of, node_id)
                        {
                            *used += 1;
                            let retry_count = *used;
                            drop(counts);
                            emit_event(
                                &ctx.app,
                                "node-retry",
                                NodeEventPayload {
                                    node_id: node_id.to_string(),
                                    message: Some(format!(
                                        "Check failed (exit code {}). Routing back to Coder node '{}' (attempt {}/{})",
                                        exit_code, coder_id, retry_count, max_retries
                                    )),
                                    output: Some(output),
                                    exit_code: Some(exit_code),
                                    retry_count: Some(retry_count),
                                    max_retries: Some(max_retries),
                                },
                            );
                            run_node(ctx.clone(), coder_id).await?;
                            continue;
                        }
                    }
                }
                emit_event(
                    &ctx.app,
                    "node-fail",
                    NodeEventPayload {
                        node_id: node_id.to_string(),
                        message: Some(format!("Node exited with code {}", exit_code)),
                        output: Some(output),
                        exit_code: Some(exit_code),
                        retry_count: None,
                        max_retries: Some(max_retries),
                    },
                );
                return Err(format!("Node '{}' failed with exit code {}", node_id, exit_code));
            }
            Err(e) => {
                emit_event(
                    &ctx.app,
                    "node-fail",
                    NodeEventPayload {
                        node_id: node_id.to_string(),
                        message: Some(e.clone()),
                        output: None,
                        exit_code: None,
                        retry_count: None,
                        max_retries: Some(max_retries),
                    },
                );
                return Err(e);
            }
        }
    }
}

async fn run_node_body(
    ctx: &Arc<ExecutionContext>,
    node_id: &str,
    node: &GraphNodeInput,
    input_context: &str,
) -> Result<(String, i32), String> {
    match node.node_type.as_str() {
        "promptNode" => Ok(run_prompt_node(ctx, node_id, node, input_context).await),
        "memoryNode" => Ok(run_memory_node(ctx, node_id, node, input_context).await),
        "memoryGraphNote" => Ok(run_note_node(ctx, node_id, node, input_context).await),
        "actionContainerNode" => run_action_container(ctx, node_id, node, input_context).await,
        "terminalNode" => {
            let command = node.data.command.clone().unwrap_or_default();
            if command.trim().is_empty() {
                Ok((input_context.to_string(), 0))
            } else {
                let exec_dir = resolve_exec_dir(ctx, node_id);
                run_shell_command(ctx, node_id, &command, input_context, &exec_dir).await
            }
        }
        _ => Ok((input_context.to_string(), 0)),
    }
}

async fn run_prompt_node(
    ctx: &Arc<ExecutionContext>,
    node_id: &str,
    node: &GraphNodeInput,
    input_context: &str,
) -> (String, i32) {
    let prompt = node.data.prompt.clone().unwrap_or_default();
    let combined = if input_context.is_empty() {
        prompt
    } else {
        format!("{}\n\n---\nUpstream context:\n{}", prompt, input_context)
    };
    emit_stream(&ctx.app, node_id, &combined);
    (combined, 0)
}

async fn run_memory_node(
    ctx: &Arc<ExecutionContext>,
    node_id: &str,
    node: &GraphNodeInput,
    input_context: &str,
) -> (String, i32) {
    let facts = node.data.facts.clone().unwrap_or_default();
    let mut output = facts.join("\n");
    if !input_context.is_empty() {
        output = format!("{}\n\n{}", output, input_context);
    }
    emit_stream(&ctx.app, node_id, &output);
    (output, 0)
}

async fn run_note_node(
    ctx: &Arc<ExecutionContext>,
    node_id: &str,
    node: &GraphNodeInput,
    input_context: &str,
) -> (String, i32) {
    let note = node.data.note.clone().unwrap_or_default();
    let output = if input_context.is_empty() {
        note
    } else {
        format!("{}\n\n{}", note, input_context)
    };
    emit_stream(&ctx.app, node_id, &output);
    (output, 0)
}

async fn run_action_container(
    ctx: &Arc<ExecutionContext>,
    node_id: &str,
    node: &GraphNodeInput,
    input_context: &str,
) -> Result<(String, i32), String> {
    let actions = node.data.actions.clone().unwrap_or_default();
    if actions.is_empty() {
        return Ok((input_context.to_string(), 0));
    }

    // All actions in this container share the node's isolated worktree so their combined
    // edits land in a single hand-off commit.
    let exec_dir = resolve_exec_dir(ctx, node_id);

    let mut combined_output = String::new();
    for action in actions {
        let (out, code) = run_shell_command(ctx, node_id, &action, input_context, &exec_dir).await?;
        combined_output.push_str(&format!("$ {}\n{}\n", action, out));
        if code != 0 {
            return Ok((combined_output, code));
        }
    }
    Ok((combined_output, 0))
}

// Spawns (or reuses) an ephemeral git worktree so this node's shell commands run against
// their own sandbox instead of the primary working tree. Falls back to the shared working
// directory when the project isn't a git repository.
fn resolve_exec_dir(ctx: &Arc<ExecutionContext>, node_id: &str) -> PathBuf {
    ctx.app
        .state::<GitEngineState>()
        .ensure_worktree(&ctx.working_dir, node_id)
        .unwrap_or_else(|_| ctx.working_dir.clone())
}

// Commits any pending edits in a node's sandbox worktree and emits a "cable-handoff" event
// carrying diff stats for every downstream reviewer/test node, before that node runs.
fn perform_handoffs(ctx: &Arc<ExecutionContext>, node_id: &str) {
    let Some(&idx) = ctx.index_of.get(node_id) else { return };
    let git_state = ctx.app.state::<GitEngineState>();

    for target_idx in ctx.graph.neighbors_directed(idx, Direction::Outgoing) {
        let target_id = &ctx.graph[target_idx];
        let is_reviewer = ctx
            .node_of
            .get(target_id)
            .is_some_and(|n| CHECK_NODE_TYPES.contains(&n.node_type.as_str()));
        if !is_reviewer {
            continue;
        }

        if let Ok(Some(result)) = git_state.commit_handoff(node_id, target_id) {
            let payload = CableHandoffPayload {
                source_node_id: node_id.to_string(),
                target_node_id: target_id.clone(),
                commit_sha: result.commit_sha,
                insertions: result.insertions,
                deletions: result.deletions,
                files_changed: result.files_changed,
            };
            let _ = ctx.app.emit("cable-handoff", payload);
        }
    }
}

fn shell_command(command: &str) -> TokioCommand {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = TokioCommand::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = TokioCommand::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.kill_on_drop(true);
    cmd
}

async fn run_shell_command(
    ctx: &Arc<ExecutionContext>,
    node_id: &str,
    command: &str,
    input_context: &str,
    working_dir: &Path,
) -> Result<(String, i32), String> {
    run_shell_command_raw(&ctx.app, node_id, command, working_dir, &[("CENTRAL_PIPELINE_INPUT", input_context)]).await
}

// Runs a shell command with live output streaming, independent of any graph ExecutionContext.
// Shared by graph node execution and disposable ephemeral one-off commands.
pub(crate) async fn run_shell_command_raw(
    app: &AppHandle,
    node_id: &str,
    command: &str,
    working_dir: &Path,
    env: &[(&str, &str)],
) -> Result<(String, i32), String> {
    let mut cmd = shell_command(command);
    cmd.current_dir(working_dir);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", command, e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let collected = Arc::new(TokioMutex::new(String::new()));

    let stdout_task = tokio::spawn(stream_lines(app.clone(), node_id.to_string(), stdout, collected.clone()));
    let stderr_task = tokio::spawn(stream_lines(app.clone(), node_id.to_string(), stderr, collected.clone()));

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed waiting for '{}': {}", command, e))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let output = collected.lock().await.clone();
    Ok((output, status.code().unwrap_or(-1)))
}

async fn stream_lines(
    app: AppHandle,
    node_id: String,
    reader: impl tokio::io::AsyncRead + Unpin,
    collected: Arc<TokioMutex<String>>,
) {
    let mut lines = TokioBufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        {
            let mut buf = collected.lock().await;
            buf.push_str(&line);
            buf.push('\n');
        }
        emit_stream(&app, &node_id, &line);
    }
}

pub(crate) fn emit_stream(app: &AppHandle, node_id: &str, chunk: &str) {
    emit_event(
        app,
        "node-streaming",
        NodeEventPayload {
            node_id: node_id.to_string(),
            message: None,
            output: Some(chunk.to_string()),
            exit_code: None,
            retry_count: None,
            max_retries: None,
        },
    );
}

pub(crate) fn emit_event(app: &AppHandle, event: &str, payload: NodeEventPayload) {
    let _ = app.emit(event, payload);
}

async fn gather_input_context(ctx: &Arc<ExecutionContext>, node_id: &str) -> String {
    let idx = match ctx.index_of.get(node_id) {
        Some(i) => *i,
        None => return String::new(),
    };
    let preds: Vec<String> = ctx
        .graph
        .neighbors_directed(idx, Direction::Incoming)
        .map(|p| ctx.graph[p].clone())
        .collect();
    if preds.is_empty() {
        return String::new();
    }

    let outputs = ctx.outputs.lock().await;
    preds
        .iter()
        .filter_map(|p| {
            outputs.get(p).map(|output| {
                let label = ctx
                    .node_of
                    .get(p)
                    .and_then(|n| n.data.label.clone())
                    .unwrap_or_else(|| p.clone());
                format!("### Output from {}\n{}", label, output)
            })
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

// Pure BFS over the DAG so retry-ancestor routing can be unit tested without an AppHandle.
fn find_nearest_coder_ancestor(
    graph: &DiGraph<String, ()>,
    index_of: &HashMap<String, NodeIndex>,
    node_of: &HashMap<String, GraphNodeInput>,
    node_id: &str,
) -> Option<String> {
    let start_idx = *index_of.get(node_id)?;
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert(start_idx);
    queue.push_back(start_idx);

    while let Some(idx) = queue.pop_front() {
        for pred_idx in graph.neighbors_directed(idx, Direction::Incoming) {
            if !visited.insert(pred_idx) {
                continue;
            }
            let pred_id = &graph[pred_idx];
            if node_of
                .get(pred_id)
                .is_some_and(|n| n.node_type == CODER_NODE_TYPE)
            {
                return Some(pred_id.clone());
            }
            queue.push_back(pred_idx);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, node_type: &str) -> GraphNodeInput {
        GraphNodeInput {
            id: id.to_string(),
            node_type: node_type.to_string(),
            data: NodeData::default(),
        }
    }

    fn edge(source: &str, target: &str) -> GraphEdgeInput {
        GraphEdgeInput { source: source.to_string(), target: target.to_string() }
    }

    #[test]
    fn build_graph_accepts_valid_dag() {
        let nodes = vec![node("prompt-1", "promptNode"), node("action-1", "actionContainerNode"), node("terminal-1", "terminalNode")];
        let edges = vec![edge("prompt-1", "action-1"), edge("action-1", "terminal-1")];
        let (graph, index_of) = build_graph(&nodes, &edges).expect("valid DAG should build");
        assert_eq!(graph.node_count(), 3);
        assert_eq!(index_of.len(), 3);
    }

    #[test]
    fn build_graph_rejects_cycle() {
        let nodes = vec![node("a", "promptNode"), node("b", "actionContainerNode")];
        let edges = vec![edge("a", "b"), edge("b", "a")];
        let result = build_graph(&nodes, &edges);
        assert!(result.is_err());
    }

    #[test]
    fn finds_direct_coder_ancestor() {
        let nodes = vec![node("prompt-1", "promptNode"), node("action-1", "actionContainerNode")];
        let edges = vec![edge("prompt-1", "action-1")];
        let (graph, index_of) = build_graph(&nodes, &edges).unwrap();
        let node_of: HashMap<String, GraphNodeInput> = nodes.into_iter().map(|n| (n.id.clone(), n)).collect();

        let ancestor = find_nearest_coder_ancestor(&graph, &index_of, &node_of, "action-1");
        assert_eq!(ancestor, Some("prompt-1".to_string()));
    }

    #[test]
    fn finds_coder_ancestor_across_multiple_hops() {
        // prompt-1 -> memory-1 -> action-1 -> terminal-1
        let nodes = vec![
            node("prompt-1", "promptNode"),
            node("memory-1", "memoryNode"),
            node("action-1", "actionContainerNode"),
            node("terminal-1", "terminalNode"),
        ];
        let edges = vec![edge("prompt-1", "memory-1"), edge("memory-1", "action-1"), edge("action-1", "terminal-1")];
        let (graph, index_of) = build_graph(&nodes, &edges).unwrap();
        let node_of: HashMap<String, GraphNodeInput> = nodes.into_iter().map(|n| (n.id.clone(), n)).collect();

        let ancestor = find_nearest_coder_ancestor(&graph, &index_of, &node_of, "terminal-1");
        assert_eq!(ancestor, Some("prompt-1".to_string()));
    }

    #[test]
    fn returns_none_when_no_coder_ancestor_exists() {
        let nodes = vec![node("action-1", "actionContainerNode"), node("terminal-1", "terminalNode")];
        let edges = vec![edge("action-1", "terminal-1")];
        let (graph, index_of) = build_graph(&nodes, &edges).unwrap();
        let node_of: HashMap<String, GraphNodeInput> = nodes.into_iter().map(|n| (n.id.clone(), n)).collect();

        let ancestor = find_nearest_coder_ancestor(&graph, &index_of, &node_of, "terminal-1");
        assert_eq!(ancestor, None);
    }

    #[test]
    fn prefers_nearest_coder_when_two_ancestors_exist() {
        // outer-coder -> bridge -> check (2 hops), inner-coder -> check (1 hop, direct)
        let nodes = vec![
            node("outer-coder", "promptNode"),
            node("bridge", "memoryNode"),
            node("inner-coder", "promptNode"),
            node("check", "terminalNode"),
        ];
        let edges = vec![edge("outer-coder", "bridge"), edge("bridge", "check"), edge("inner-coder", "check")];
        let (graph, index_of) = build_graph(&nodes, &edges).unwrap();
        let node_of: HashMap<String, GraphNodeInput> = nodes.into_iter().map(|n| (n.id.clone(), n)).collect();

        let ancestor = find_nearest_coder_ancestor(&graph, &index_of, &node_of, "check");
        assert_eq!(ancestor, Some("inner-coder".to_string()));
    }
}
