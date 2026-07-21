//! Multi-agent task orchestration: takes a Decomposer-produced task list and runs it as a team
//! of headless CLI agents that don't fight each other — each task gets its own worktree/branch
//! (`run.rs`'s dispatcher, scheduled by the pure functions in `scheduler.rs`), and a strictly
//! sequential integrator merges finished branches onto a shared `central/staging` branch
//! (`git_engine.rs`), running the project's test command and bouncing a task back to its agent
//! on conflict/failure before finally promoting staging to the project's main branch.

// `pub` (rather than re-exported through `pub use`) because #[tauri::command] attaches hidden
// macro-generated items scoped to the function's actual defining module; `generate_handler!` in
// lib.rs needs to name commands at that real path (`orchestration::run::start_orchestration_run`),
// the same convention this crate already follows for `memory::engine::*` and `mcp::commands::*`.
pub mod run;
mod scheduler;
mod task;

pub use run::OrchestrationState;
