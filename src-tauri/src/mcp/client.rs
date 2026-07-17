use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct McpNotificationPayload {
    server_id: String,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct McpServerExitPayload {
    server_id: String,
    message: Option<String>,
}

type PendingMap = Arc<TokioMutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

// A single spawned local MCP server reached over its stdio JSON-RPC transport: one line of
// UTF-8 JSON per message, no LSP-style Content-Length framing.
pub struct McpClient {
    stdin: Arc<TokioMutex<ChildStdin>>,
    pending: PendingMap,
    next_id: AtomicI64,
    child: Arc<TokioMutex<Child>>,
}

impl McpClient {
    pub async fn spawn(
        server_id: String,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        app: AppHandle,
    ) -> Result<Self, String> {
        let mut cmd = TokioCommand::new(&command);
        cmd.args(&args);
        for (k, v) in &env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn MCP server '{} {}': {}",
                command,
                args.join(" "),
                e
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to capture MCP server stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to capture MCP server stdout")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Failed to capture MCP server stderr")?;

        let pending: PendingMap = Arc::new(TokioMutex::new(HashMap::new()));

        // Dispatches JSON-RPC responses to whichever call is awaiting that id, and forwards
        // server-initiated notifications (e.g. tools/list_changed) as a Tauri event.
        let reader_pending = pending.clone();
        let reader_server_id = server_id.clone();
        let reader_app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };

                if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
                    let sender = { reader_pending.lock().await.remove(&id) };
                    if let Some(tx) = sender {
                        if let Some(err) = value.get("error") {
                            let _ = tx.send(Err(err.to_string()));
                        } else {
                            let result = value.get("result").cloned().unwrap_or(Value::Null);
                            let _ = tx.send(Ok(result));
                        }
                    }
                } else if let Some(method) = value.get("method").and_then(|v| v.as_str()) {
                    let _ = reader_app.emit(
                        "mcp-notification",
                        McpNotificationPayload {
                            server_id: reader_server_id.clone(),
                            method: method.to_string(),
                            params: value.get("params").cloned(),
                        },
                    );
                }
            }
        });

        // Surfaces server-side stderr diagnostics (npx install logs, warnings) to the UI.
        let stderr_server_id = server_id.clone();
        let stderr_app = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = stderr_app.emit(
                    "mcp-notification",
                    McpNotificationPayload {
                        server_id: stderr_server_id.clone(),
                        method: "stderr".to_string(),
                        params: Some(json!({ "line": line })),
                    },
                );
            }
        });

        let client = McpClient {
            stdin: Arc::new(TokioMutex::new(stdin)),
            pending,
            next_id: AtomicI64::new(1),
            child: Arc::new(TokioMutex::new(child)),
        };

        let exit_child = client.child.clone();
        let exit_app = app;
        let exit_server_id = server_id;
        tokio::spawn(async move {
            let status = exit_child.lock().await.wait().await;
            let message = match status {
                Ok(s) => format!("MCP server exited with status {}", s),
                Err(e) => e.to_string(),
            };
            let _ = exit_app.emit(
                "mcp-server-exit",
                McpServerExitPayload {
                    server_id: exit_server_id,
                    message: Some(message),
                },
            );
        });

        Ok(client)
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_line(&request).await?;

        let response = tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| format!("MCP request '{}' timed out", method))?
            .map_err(|_| "MCP server closed the connection".to_string())?;

        response
    }

    async fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let notification = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.write_line(&notification).await
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    // Performs the MCP `initialize` handshake, then sends the required `notifications/initialized`
    // follow-up so the server knows it can start accepting further requests.
    pub async fn initialize(&self) -> Result<(Option<String>, Option<String>), String> {
        let params = json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "central-canvas-architect", "version": "0.1.0" },
        });
        let result = self.send_request("initialize", params).await?;
        self.send_notification("notifications/initialized", json!({}))
            .await?;

        let name = result
            .pointer("/serverInfo/name")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let version = result
            .pointer("/serverInfo/version")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        Ok((name, version))
    }

    pub async fn list_tools(&self) -> Result<Vec<McpTool>, String> {
        let result = self.send_request("tools/list", json!({})).await?;
        serde_json::from_value(result.get("tools").cloned().unwrap_or(Value::Array(vec![])))
            .map_err(|e| e.to_string())
    }

    pub async fn call_tool(&self, tool_name: &str, arguments: Value) -> Result<Value, String> {
        let params = json!({ "name": tool_name, "arguments": arguments });
        self.send_request("tools/call", params).await
    }

    pub async fn shutdown(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}
