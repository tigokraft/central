use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

// Every spawned PTY gets a unique instance id, even when it reuses a node_id that a
// previous (now-killed) session also used. This lets a stale reader thread recognize that
// the session it was reading has already been replaced, so it never tears down or emits an
// exit event for the wrong, currently-live PTY instance.
static PTY_INSTANCE_SEQ: AtomicU64 = AtomicU64::new(0);

// Kept small enough to be cheap to hold per session, large enough to cover what a "quiet"
// terminal's status strip needs plus a useful backlog when the user expands it to live.
const SCROLLBACK_CAPACITY: usize = 64 * 1024;

// Fixed-capacity byte ring buffer of a PTY session's raw output, kept regardless of display
// mode so expanding a quiet terminal to live can replay its backlog. Bytes beyond the
// capacity are silently dropped (oldest first) rather than growing unbounded.
pub struct ScrollbackBuffer {
    buf: Vec<u8>,
    capacity: usize,
    // Index the *next* write lands on.
    write_pos: usize,
    // Number of valid bytes currently stored; saturates at capacity once the buffer wraps.
    len: usize,
}

impl ScrollbackBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            buf: vec![0u8; capacity],
            capacity,
            write_pos: 0,
            len: 0,
        }
    }

    fn append(&mut self, data: &[u8]) {
        if data.is_empty() || self.capacity == 0 {
            return;
        }
        // Only the trailing `capacity` bytes could ever survive in the buffer, so a chunk
        // larger than that can be truncated up front instead of writing bytes that would
        // just get overwritten again before drain_ordered ever sees them.
        let data = if data.len() > self.capacity {
            &data[data.len() - self.capacity..]
        } else {
            data
        };

        let space_to_end = self.capacity - self.write_pos;
        if data.len() <= space_to_end {
            self.buf[self.write_pos..self.write_pos + data.len()].copy_from_slice(data);
        } else {
            self.buf[self.write_pos..].copy_from_slice(&data[..space_to_end]);
            self.buf[..data.len() - space_to_end].copy_from_slice(&data[space_to_end..]);
        }
        self.write_pos = (self.write_pos + data.len()) % self.capacity;
        self.len = (self.len + data.len()).min(self.capacity);
    }

    // Discards all currently buffered bytes without shrinking the underlying allocation.
    fn clear(&mut self) {
        self.write_pos = 0;
        self.len = 0;
    }

    // Returns the buffered bytes in write order (oldest first).
    fn drain_ordered(&self) -> Vec<u8> {
        if self.len < self.capacity {
            self.buf[..self.len].to_vec()
        } else {
            let mut out = Vec::with_capacity(self.capacity);
            out.extend_from_slice(&self.buf[self.write_pos..]);
            out.extend_from_slice(&self.buf[..self.write_pos]);
            out
        }
    }
}

pub struct PtyProcess {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub instance_id: u64,
    pub scrollback: Arc<Mutex<ScrollbackBuffer>>,
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

// Pure and AppHandle-free so the cwd wiring can be unit tested without spawning a real PTY.
fn build_pty_command(shell_name: &str, cwd: &Path) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell_name);
    cmd.cwd(cwd);
    cmd
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

    let cwd = crate::git_engine::resolve_repo_root(&app_handle);
    let cmd = build_pty_command(&shell_name, &cwd);

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
    let scrollback_shared = Arc::new(Mutex::new(ScrollbackBuffer::new(SCROLLBACK_CAPACITY)));

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
                scrollback: scrollback_shared.clone(),
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
                    // Recorded regardless of display mode — a quiet terminal expanded to
                    // live later still needs its backlog.
                    scrollback_shared.lock().unwrap().append(&buf[..n]);
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
        writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
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
pub fn get_pty_scrollback(node_id: String, state: State<'_, PtyManager>) -> Result<String, String> {
    let processes = state.processes.lock().unwrap();
    if let Some(proc) = processes.get(&node_id) {
        let bytes = proc.scrollback.lock().unwrap().drain_ordered();
        Ok(String::from_utf8_lossy(&bytes).to_string())
    } else {
        Err(format!("No active PTY session for node ID: {}", node_id))
    }
}

#[tauri::command]
pub fn clear_pty_scrollback(node_id: String, state: State<'_, PtyManager>) -> Result<(), String> {
    let processes = state.processes.lock().unwrap();
    if let Some(proc) = processes.get(&node_id) {
        proc.scrollback.lock().unwrap().clear();
        Ok(())
    } else {
        Err(format!("No active PTY session for node ID: {}", node_id))
    }
}

#[tauri::command]
pub fn destroy_pty(node_id: String, state: State<'_, PtyManager>) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_pty_command_sets_cwd_to_given_path() {
        let cwd = Path::new("/tmp/some-project");
        let cmd = build_pty_command("bash", cwd);
        assert_eq!(cmd.get_cwd().map(|s| s.as_os_str()), Some(cwd.as_os_str()));
    }

    #[test]
    fn scrollback_drain_is_empty_before_any_append() {
        let buf = ScrollbackBuffer::new(8);
        assert_eq!(buf.drain_ordered(), Vec::<u8>::new());
    }

    #[test]
    fn scrollback_drain_returns_appended_bytes_in_order_below_capacity() {
        let mut buf = ScrollbackBuffer::new(8);
        buf.append(b"ab");
        buf.append(b"cd");
        assert_eq!(buf.drain_ordered(), b"abcd".to_vec());
    }

    #[test]
    fn scrollback_wraparound_keeps_only_the_most_recent_capacity_bytes_in_order() {
        let mut buf = ScrollbackBuffer::new(8);
        buf.append(b"abcdefgh"); // exactly fills the buffer
        buf.append(b"ijkl"); // wraps, overwriting "abcd"
        assert_eq!(buf.drain_ordered(), b"efghijkl".to_vec());
    }

    #[test]
    fn scrollback_single_append_larger_than_capacity_keeps_only_the_tail() {
        let mut buf = ScrollbackBuffer::new(4);
        buf.append(b"0123456789");
        assert_eq!(buf.drain_ordered(), b"6789".to_vec());
    }

    #[test]
    fn scrollback_many_small_appends_wrap_correctly() {
        let mut buf = ScrollbackBuffer::new(5);
        for byte in b"abcdefghij" {
            buf.append(&[*byte]);
        }
        assert_eq!(buf.drain_ordered(), b"fghij".to_vec());
    }

    #[test]
    fn scrollback_clear_empties_the_buffer_and_appends_after_clear_start_fresh() {
        let mut buf = ScrollbackBuffer::new(8);
        buf.append(b"abcdefgh");
        buf.clear();
        assert_eq!(buf.drain_ordered(), Vec::<u8>::new());
        buf.append(b"ij");
        assert_eq!(buf.drain_ordered(), b"ij".to_vec());
    }
}
