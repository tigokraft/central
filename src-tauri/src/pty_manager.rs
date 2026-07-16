use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use portable_pty::{native_pty_system, CommandBuilder, PtySize, MasterPty, Child};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Manager};

// Every spawned PTY gets a unique instance id, even when it reuses a node_id that a
// previous (now-killed) session also used. This lets a stale reader thread recognize that
// the session it was reading has already been replaced, so it never tears down or emits an
// exit event for the wrong, currently-live PTY instance.
static PTY_INSTANCE_SEQ: AtomicU64 = AtomicU64::new(0);

pub struct PtyProcess {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub instance_id: u64,
}

#[derive(Default)]
pub struct PtyManager {
    pub processes: Arc<Mutex<HashMap<String, PtyProcess>>>,
}

#[derive(Serialize, Clone)]
struct PtyOutputPayload {
    node_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExitPayload {
    node_id: String,
}

#[tauri::command]
pub fn spawn_pty(
    node_id: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    state: State<'_, PtyManager>,
    app_handle: AppHandle,
) -> Result<(), String> {
    // 1. Clean up existing session for this node if it exists
    {
        let mut processes = state.processes.lock().unwrap();
        if let Some(proc) = processes.remove(&node_id) {
            let mut child = proc.child.lock().unwrap();
            let _ = child.kill();
        }
    }

    // 2. Select shell command
    let shell_name = shell.clone().unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            "cmd.exe".to_string()
        } else {
            "bash".to_string()
        }
    });

    let mut cmd = CommandBuilder::new(&shell_name);

    // Set CWD to the project root (up from src-tauri if applicable)
    if let Ok(mut current) = std::env::current_dir() {
        if current.ends_with("src-tauri") {
            current.pop();
        }
        cmd.cwd(current);
    }

    // 3. Open PTY pair
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // 4. Spawn the command
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    // Drop the slave handle to let reader detect EOF properly
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let writer_shared = Arc::new(Mutex::new(writer));
    let child_boxed: Box<dyn Child + Send + Sync> = child;
    let child_shared = Arc::new(Mutex::new(child_boxed));
    let instance_id = PTY_INSTANCE_SEQ.fetch_add(1, Ordering::SeqCst);

    // Store PTY process information
    {
        let mut processes = state.processes.lock().unwrap();
        processes.insert(
            node_id.clone(),
            PtyProcess {
                master: pair.master,
                writer: writer_shared.clone(),
                child: child_shared.clone(),
                instance_id,
            },
        );
    }

    // 5. Spawn standard thread to read from blocking reader
    let node_id_clone = node_id.clone();
    let app_handle_clone = app_handle.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let payload = PtyOutputPayload {
                        node_id: node_id_clone.clone(),
                        data,
                    };
                    let _ = app_handle_clone.emit("pty-output", payload);
                }
                Err(_) => break,
            }
        }

        // Only tear down and notify the frontend if this thread's PTY instance is still
        // the one registered for node_id. If it was already replaced by a fresher respawn,
        // silently exit instead of clobbering the newer session's state.
        let is_current_instance = if let Some(mgr) = app_handle_clone.try_state::<PtyManager>() {
            let mut processes = mgr.processes.lock().unwrap();
            let is_current = processes
                .get(&node_id_clone)
                .is_some_and(|p| p.instance_id == instance_id);
            if is_current {
                processes.remove(&node_id_clone);
            }
            is_current
        } else {
            false
        };

        if is_current_instance {
            let _ = app_handle_clone.emit(
                "pty-exit",
                PtyExitPayload {
                    node_id: node_id_clone,
                },
            );
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_pty(
    node_id: String,
    data: String,
    state: State<'_, PtyManager>,
) -> Result<(), String> {
    let proc = {
        let processes = state.processes.lock().unwrap();
        processes.get(&node_id).map(|p| p.writer.clone())
    };

    if let Some(writer_lock) = proc {
        let mut writer = writer_lock.lock().unwrap();
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("No active PTY session for node ID: {}", node_id))
    }
}

#[tauri::command]
pub fn resize_pty(
    node_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyManager>,
) -> Result<(), String> {
    if let Some(proc) = state.processes.lock().unwrap().get(&node_id) {
        proc.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("No active PTY session for node ID: {}", node_id))
    }
}

#[tauri::command]
pub fn destroy_pty(
    node_id: String,
    state: State<'_, PtyManager>,
) -> Result<(), String> {
    let proc = {
        let mut processes = state.processes.lock().unwrap();
        processes.remove(&node_id)
    };

    if let Some(proc) = proc {
        let mut child = proc.child.lock().unwrap();
        let _ = child.kill();
        Ok(())
    } else {
        Err(format!("No active PTY session for node ID: {}", node_id))
    }
}
