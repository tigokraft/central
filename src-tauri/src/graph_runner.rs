use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use petgraph::algo::toposort;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::Direction;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as TokioMutex;

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
struct NodeEventPayload {
    node_id: String,
    message: Option<String>,
    output: Option<String>,
    exit_code: Option<i32>,
    retry_count: Option<u32>,
    max_retries: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GraphEventPayload {
    ok: bool,
    message: Option<String>,
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

    let mut graph = DiGraph::<String, ()>::new();
    let mut index_of = HashMap::new();
    for n in &nodes {
        index_of.insert(n.id.clone(), graph.add_node(n.id.clone()));
    }
    for e in &edges {
        if let (Some(&s), Some(&t)) = (index_of.get(&e.source), index_of.get(&e.target)) {
            graph.add_edge(s, t, ());
        }
    }

    if toposort(&graph, None).is_err() {
        state.running.store(false, Ordering::SeqCst);
        return Err("Execution graph contains a cycle".to_string());
    }

    let node_locks = nodes.iter().map(|n| (n.id.clone(), TokioMutex::new(()))).collect();
    let node_of: HashMap<String, GraphNodeInput> =
        nodes.into_iter().map(|n| (n.id.clone(), n)).collect();

    let mut working_dir = std::env::current_dir().unwrap_or_default();
    if working_dir.ends_with("src-tauri") {
        working_dir.pop();
    }

    let ctx = Arc::new(ExecutionContext {
        app: app_handle.clone(),
        outputs: TokioMutex::new(HashMap::new()),
        retry_counts: TokioMutex::new(HashMap::new()),
        node_locks,
        graph,
        index_of,
        node_of,
        working_dir,
    });

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
                return Ok(());
            }
            Ok((output, exit_code)) => {
                if is_check_node {
                    let mut counts = ctx.retry_counts.lock().await;
                    let used = counts.entry(node_id.to_string()).or_insert(0);
                    if *used < max_retries {
                        if let Some(coder_id) = find_nearest_coder_ancestor(ctx, node_id) {
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
                run_shell_command(ctx, node_id, &command, input_context).await
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

    let mut combined_output = String::new();
    for action in actions {
        let (out, code) = run_shell_command(ctx, node_id, &action, input_context).await?;
        combined_output.push_str(&format!("$ {}\n{}\n", action, out));
        if code != 0 {
            return Ok((combined_output, code));
        }
    }
    Ok((combined_output, 0))
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
) -> Result<(String, i32), String> {
    let mut cmd = shell_command(command);
    cmd.current_dir(&ctx.working_dir);
    cmd.env("CENTRAL_PIPELINE_INPUT", input_context);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", command, e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let collected = Arc::new(TokioMutex::new(String::new()));

    let stdout_task = tokio::spawn(stream_lines(ctx.app.clone(), node_id.to_string(), stdout, collected.clone()));
    let stderr_task = tokio::spawn(stream_lines(ctx.app.clone(), node_id.to_string(), stderr, collected.clone()));

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

fn emit_stream(app: &AppHandle, node_id: &str, chunk: &str) {
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

fn emit_event(app: &AppHandle, event: &str, payload: NodeEventPayload) {
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

fn find_nearest_coder_ancestor(ctx: &Arc<ExecutionContext>, node_id: &str) -> Option<String> {
    let start_idx = *ctx.index_of.get(node_id)?;
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert(start_idx);
    queue.push_back(start_idx);

    while let Some(idx) = queue.pop_front() {
        for pred_idx in ctx.graph.neighbors_directed(idx, Direction::Incoming) {
            if !visited.insert(pred_idx) {
                continue;
            }
            let pred_id = &ctx.graph[pred_idx];
            if ctx
                .node_of
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
