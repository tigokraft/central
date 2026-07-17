use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use super::client::{McpClient, McpTool};
use super::McpManagerState;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectResult {
    pub server_id: String,
    pub name: Option<String>,
    pub version: Option<String>,
    pub tools: Vec<McpTool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub server_id: String,
    pub connected: bool,
}

// Spawns a local MCP server over stdio (e.g. `npx -y @modelcontextprotocol/server-postgres`),
// completes the initialize handshake, and returns its advertised tool catalog.
#[tauri::command]
pub async fn mcp_connect_server(
    server_id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    app: AppHandle,
    state: State<'_, McpManagerState>,
) -> Result<McpConnectResult, String> {
    let client = McpClient::spawn(
        server_id.clone(),
        command,
        args,
        env.unwrap_or_default(),
        app,
    )
    .await?;
    let (name, version) = client.initialize().await?;
    let tools = client.list_tools().await.unwrap_or_default();

    state
        .clients
        .lock()
        .await
        .insert(server_id.clone(), Arc::new(client));

    Ok(McpConnectResult {
        server_id,
        name,
        version,
        tools,
    })
}

#[tauri::command]
pub async fn mcp_disconnect_server(
    server_id: String,
    state: State<'_, McpManagerState>,
) -> Result<(), String> {
    let client = state.clients.lock().await.remove(&server_id);
    if let Some(client) = client {
        client.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_list_tools(
    server_id: String,
    state: State<'_, McpManagerState>,
) -> Result<Vec<McpTool>, String> {
    let client = state
        .clients
        .lock()
        .await
        .get(&server_id)
        .cloned()
        .ok_or_else(|| format!("No connected MCP server '{}'", server_id))?;
    client.list_tools().await
}

#[tauri::command]
pub async fn mcp_call_tool(
    server_id: String,
    tool_name: String,
    arguments: Option<Value>,
    state: State<'_, McpManagerState>,
) -> Result<Value, String> {
    let client = state
        .clients
        .lock()
        .await
        .get(&server_id)
        .cloned()
        .ok_or_else(|| format!("No connected MCP server '{}'", server_id))?;
    client
        .call_tool(
            &tool_name,
            arguments.unwrap_or(Value::Object(Default::default())),
        )
        .await
}

#[tauri::command]
pub async fn mcp_list_servers(
    state: State<'_, McpManagerState>,
) -> Result<Vec<McpServerStatus>, String> {
    let clients = state.clients.lock().await;
    Ok(clients
        .keys()
        .map(|id| McpServerStatus {
            server_id: id.clone(),
            connected: true,
        })
        .collect())
}
