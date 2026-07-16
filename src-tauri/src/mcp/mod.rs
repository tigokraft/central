pub mod client;
pub mod commands;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex as TokioMutex;

use client::McpClient;

#[derive(Default)]
pub struct McpManagerState {
    clients: Arc<TokioMutex<HashMap<String, Arc<McpClient>>>>,
}
